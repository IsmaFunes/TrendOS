/**
 * Automatic Meta ad -> Mercado Libre product matching, run once per niche
 * bucket for its top-ranked ads (shared across every store in the niche)
 * instead of only on-demand per (ad, user) via the "Investigar" button.
 *
 * Reuses the same product-extraction and ML-search building blocks as
 * investigate.ts (extractProductSignalWithGemini, the SerpAPI Google
 * Shopping + Gemini web-search-grounding ML sources, and the confidence-
 * tiered rankMlMatches) rather than duplicating that logic — this module is
 * the trigger/orchestration + niche-level caching layer on top of it.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  extractProductSignalWithGemini,
  rankMlMatches,
  type RankedMlMatch,
} from "./investigate";
import { searchMercadoLibreViaShopping } from "./providers/serpapiShopping";
import { researchMercadoLibreListings } from "./providers/geminiResearch";
import { textSimilarity } from "./normalize";
import type { ExternalProduct } from "./contracts";
import { structuredLog } from "./http";
import { mlMatchResultValidator } from "./validators";

const AR = "AR";
/** Bound SerpAPI/Gemini spend per niche regardless of how big the niche is. */
const TOP_ADS_PER_NICHE = 12;
const NICHE_MATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Above this, a gemini_research match is corroborated by a structured SerpAPI result. */
const CORROBORATION_MIN_SIMILARITY = 0.5;

type MatchTargetAd = {
  adId: Id<"radarAds">;
  pageName: string;
  body: string;
  mediaUrls: string[];
  videoUrl?: string;
};

export const loadTopNicheAdsForMatching = internalQuery({
  args: { nicheId: v.id("radarNiches"), now: v.number() },
  returns: v.array(
    v.object({
      adId: v.id("radarAds"),
      pageName: v.string(),
      body: v.string(),
      mediaUrls: v.array(v.string()),
      videoUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args): Promise<MatchTargetAd[]> => {
    const relevance = await ctx.db
      .query("radarNicheAdRelevance")
      .withIndex("by_niche", (q) => q.eq("nicheId", args.nicheId))
      .unique();
    if (!relevance) return [];

    const topAdIds = [...relevance.ranked]
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_ADS_PER_NICHE)
      .map((r) => r.adId);

    const out: MatchTargetAd[] = [];
    for (const adId of topAdIds) {
      const existing = await ctx.db
        .query("radarNicheAdProductMatches")
        .withIndex("by_niche_ad", (q) =>
          q.eq("nicheId", args.nicheId).eq("adId", adId),
        )
        .unique();
      if (existing && existing.expiresAt > args.now) continue;

      const ad = await ctx.db.get(adId);
      if (!ad || ad.country !== AR) continue;
      const body = ad.body?.trim();
      if (!body) continue;
      out.push({
        adId,
        pageName: ad.pageName,
        body,
        mediaUrls: ad.mediaUrls,
        videoUrl: ad.videoUrl,
      });
    }
    return out;
  },
});

export const saveNicheAdProductMatch = internalMutation({
  args: {
    nicheId: v.id("radarNiches"),
    adId: v.id("radarAds"),
    status: v.union(
      v.literal("matched"),
      v.literal("no_match"),
      v.literal("not_a_product"),
      v.literal("error"),
    ),
    productName: v.optional(v.string()),
    bestMatch: v.optional(mlMatchResultValidator),
    allMatches: v.array(mlMatchResultValidator),
    verificationStatus: v.optional(
      v.union(
        v.literal("cross_source_corroborated"),
        v.literal("unverified_single_source"),
      ),
    ),
    errorMessage: v.optional(v.string()),
  },
  returns: v.id("radarNicheAdProductMatches"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("radarNicheAdProductMatches")
      .withIndex("by_niche_ad", (q) =>
        q.eq("nicheId", args.nicheId).eq("adId", args.adId),
      )
      .unique();
    const doc = {
      nicheId: args.nicheId,
      adId: args.adId,
      status: args.status,
      productName: args.productName,
      bestMatch: args.bestMatch,
      allMatches: args.allMatches,
      verificationStatus: args.verificationStatus,
      errorMessage: args.errorMessage,
      createdAt: now,
      expiresAt: now + NICHE_MATCH_TTL_MS,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("radarNicheAdProductMatches", doc);
  },
});

/**
 * Only a gemini_research (web-search-grounded, unverified) best match needs
 * a corroboration signal — a structured SerpAPI Google Shopping result is
 * already a real priced listing, and full content-fetch verification of
 * mercadolibre.com.ar is unreliable (bot-gated), so this is the cheap
 * middle ground: does an independent, structurally different source agree.
 */
function verificationStatusFor(
  best: RankedMlMatch,
  allItems: ExternalProduct[],
): "cross_source_corroborated" | "unverified_single_source" | undefined {
  if (best.source !== "gemini_research") return undefined;
  const corroborated = allItems.some(
    (item) =>
      item.source !== "gemini_research" &&
      textSimilarity(best.title, item.title) >= CORROBORATION_MIN_SIMILARITY,
  );
  return corroborated ? "cross_source_corroborated" : "unverified_single_source";
}

/**
 * Product extraction (Gemini vision) + ML search (SerpAPI + Gemini) for one
 * ad. Pulled out of the batch loop so it can run concurrently across ads
 * instead of one-at-a-time — sequential processing of ~12 ads at ~20s each
 * was the single largest contributor to the multi-minute wait after a
 * scrape (confirmed: 3.6 minutes for 12 ads, one at a time).
 */
async function matchOneAd(
  ctx: ActionCtx,
  nicheId: Id<"radarNiches">,
  ad: MatchTargetAd,
): Promise<void> {
  try {
    const signal = await extractProductSignalWithGemini(
      ad.pageName,
      ad.body,
      ad.mediaUrls,
      ad.videoUrl,
    );

    if (!signal) {
      await ctx.runMutation(
        internal.radar.nicheMatching.saveNicheAdProductMatch,
        {
          nicheId,
          adId: ad.adId,
          status: "error",
          allMatches: [],
          errorMessage: "product_extraction_failed",
        },
      );
      return;
    }

    if (!signal.isPhysicalProduct) {
      await ctx.runMutation(
        internal.radar.nicheMatching.saveNicheAdProductMatch,
        {
          nicheId,
          adId: ad.adId,
          status: "not_a_product",
          allMatches: [],
          errorMessage: signal.notAProductReason,
        },
      );
      return;
    }

    const mlItems: ExternalProduct[] = [];
    const [shoppingResult, geminiListingsResult] = await Promise.allSettled([
      searchMercadoLibreViaShopping(signal.searchQuery, { limit: 10 }),
      researchMercadoLibreListings({ productName: signal.productName }),
    ]);

    if (shoppingResult.status === "fulfilled") {
      mlItems.push(...shoppingResult.value.items);
    } else {
      structuredLog({
        source: "niche_matching_shopping",
        errorType: "fetch_failed",
        message:
          shoppingResult.reason instanceof Error
            ? shoppingResult.reason.message
            : "error",
      });
    }
    if (geminiListingsResult.status === "fulfilled") {
      mlItems.push(
        ...geminiListingsResult.value.map(
          (l): ExternalProduct => ({
            externalId: l.url,
            source: "gemini_research",
            title: l.title,
            externalUrl: l.url,
            imageUrl: l.imageUrl,
            price: l.price,
            currency: l.currency,
            sellerName: l.sellerName,
            condition: l.condition,
          }),
        ),
      );
    } else {
      structuredLog({
        source: "niche_matching_gemini_research",
        errorType: "fetch_failed",
        message:
          geminiListingsResult.reason instanceof Error
            ? geminiListingsResult.reason.message
            : "error",
      });
    }

    const { matches } = rankMlMatches(signal.searchQuery, mlItems, 3);
    const best = matches[0];

    await ctx.runMutation(internal.radar.nicheMatching.saveNicheAdProductMatch, {
      nicheId,
      adId: ad.adId,
      status: best ? "matched" : "no_match",
      productName: signal.productName,
      bestMatch: best,
      allMatches: matches,
      verificationStatus: best ? verificationStatusFor(best, mlItems) : undefined,
    });
  } catch (err) {
    structuredLog({
      source: "niche_matching",
      errorType: "unexpected_error",
      message: err instanceof Error ? err.message : String(err),
    });
    await ctx.runMutation(internal.radar.nicheMatching.saveNicheAdProductMatch, {
      nicheId,
      adId: ad.adId,
      status: "error",
      allMatches: [],
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    });
  }
}

/** Bound concurrent Gemini/SerpAPI calls rather than firing all 12 at once. */
const MATCHING_CONCURRENCY = 4;

export const runNicheProductMatching = internalAction({
  args: { nicheId: v.id("radarNiches") },
  returns: v.object({ processed: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const targets: MatchTargetAd[] = await ctx.runQuery(
      internal.radar.nicheMatching.loadTopNicheAdsForMatching,
      { nicheId: args.nicheId, now },
    );

    for (let i = 0; i < targets.length; i += MATCHING_CONCURRENCY) {
      const batch = targets.slice(i, i + MATCHING_CONCURRENCY);
      await Promise.all(batch.map((ad) => matchOneAd(ctx, args.nicheId, ad)));
    }

    return { processed: targets.length };
  },
});
