/**
 * One-off migration to run after (a) tightening the ad-relevance gate
 * (convex/radar/adRelevance.ts hasNicheKeywordOverlap) or the niche
 * fuzzy-merge threshold, and (b) making the niche-shared Gemini relevance
 * pass a MANDATORY gate for the feed (convex/radar/metaAds.ts
 * listAdsForUser). Recomputes each niche's adCount against ads that still
 * pass the CURRENT gate, re-enqueues a scrape for any niche that drops
 * below MIN_ADS_READY as a result, and kicks off an initial relevance pass
 * for every niche left "ready" — without this, every EXISTING niche would
 * show an empty feed after deploy until its next scrape happens to
 * re-trigger a relevance refresh on its own.
 *
 *   npx convex run admin/regateNiches:regateNiches
 */

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { passesNicheAdGate } from "../radar/adRelevance";
import { MIN_ADS_READY, enqueueScrapeIfNeeded } from "../radar/niches";

export const regateNicheBatch = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    isDone: v.boolean(),
    continueCursor: v.string(),
    processed: v.number(),
    reenqueued: v.number(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("radarNiches").paginate(args.paginationOpts);

    let reenqueued = 0;
    for (const niche of page.page) {
      if (niche.status === "scraping") continue;

      const links = await ctx.db
        .query("radarNicheAds")
        .withIndex("by_niche", (q) => q.eq("nicheId", niche._id))
        .take(1000);

      const gateKeywords = [...niche.keywords, ...(niche.scrapeTerms ?? [])];
      let passing = 0;
      for (const link of links) {
        const ad = await ctx.db.get(link.adId);
        if (!ad) continue;
        if (
          passesNicheAdGate(
            {
              pageName: ad.pageName,
              body: ad.body,
              mediaUrls: ad.mediaUrls,
              destinationUrl: ad.destinationUrl,
              searchTerm: ad.searchTerm,
            },
            gateKeywords,
          )
        ) {
          passing += 1;
        }
      }

      const newStatus = passing >= MIN_ADS_READY ? "ready" : "pending_scrape";
      if (niche.adCount !== passing || niche.status !== newStatus) {
        await ctx.db.patch(niche._id, {
          adCount: passing,
          status: newStatus,
          updatedAt: Date.now(),
        });
      }
      if (newStatus === "pending_scrape") {
        if (await enqueueScrapeIfNeeded(ctx, niche._id)) reenqueued += 1;
      } else if (passing > 0) {
        // force:true — see the matching comment in metaAds.ts upsertAdsBatch:
        // the freshness cache is keyed on the niche's fingerprint, which this
        // migration doesn't change, so an un-forced refresh would just report
        // "fresh" and skip recomputation for niches that already had one.
        await ctx.scheduler.runAfter(
          0,
          internal.radar.geminiAds.refreshNicheAdRelevance,
          { nicheId: niche._id, force: true },
        );
      }
    }

    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      processed: page.page.length,
      reenqueued,
    };
  },
});

export const regateNiches = internalAction({
  args: {},
  returns: v.object({ processed: v.number(), reenqueued: v.number() }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let processed = 0;
    let reenqueued = 0;
    for (;;) {
      const batch: {
        isDone: boolean;
        continueCursor: string;
        processed: number;
        reenqueued: number;
      } = await ctx.runMutation(internal.admin.regateNiches.regateNicheBatch, {
        paginationOpts: { numItems: 50, cursor },
      });
      processed += batch.processed;
      reenqueued += batch.reenqueued;
      if (batch.isDone) break;
      cursor = batch.continueCursor;
    }
    return { processed, reenqueued };
  },
});
