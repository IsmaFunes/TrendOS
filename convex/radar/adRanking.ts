/**
 * Cached niche-shared Gemini relevance pass for the ad feed — the mandatory
 * gate `listAdsForUser` requires before showing any ad from a fixed catalog
 * niche (convex/radar/niches.ts).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { passesNicheAdGate } from "./adRelevance";
import { flattenedGateTerms } from "./niches";
import {
  MAX_ADS_TO_RANK,
  NICHE_AD_RELEVANCE_TTL_MS,
  nicheFingerprint,
} from "./geminiAdsCore";
import { clampScore } from "./metrics";

function activeDays(startedAt: number | undefined, lastSeenAt: number): number {
  if (!startedAt) return 0;
  return Math.max(
    0,
    Math.floor((lastSeenAt - startedAt) / (24 * 60 * 60 * 1000)),
  );
}

/** UI helper: has this niche ever completed a relevance pass, and is it fresh? */
export const getNicheRelevanceState = query({
  args: { nicheId: v.id("radarNiches"), now: v.number() },
  returns: v.object({
    status: v.union(
      v.literal("missing"),
      v.literal("stale"),
      v.literal("fresh"),
    ),
    expiresAt: v.optional(v.number()),
    rankedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const niche = await ctx.db.get(args.nicheId);
    if (!niche) return { status: "missing" as const, rankedCount: 0 };
    const relevance = await ctx.db
      .query("radarNicheAdRelevance")
      .withIndex("by_niche", (q) => q.eq("nicheId", args.nicheId))
      .unique();
    if (!relevance) return { status: "missing" as const, rankedCount: 0 };
    const fp = nicheFingerprint({
      label: niche.label,
      gateTerms: flattenedGateTerms(niche),
    });
    if (relevance.fingerprint !== fp || relevance.expiresAt <= args.now) {
      return {
        status: "stale" as const,
        expiresAt: relevance.expiresAt,
        rankedCount: relevance.ranked.length,
      };
    }
    return {
      status: "fresh" as const,
      expiresAt: relevance.expiresAt,
      rankedCount: relevance.ranked.length,
    };
  },
});

export const loadNicheRelevanceContext = internalQuery({
  args: { nicheId: v.id("radarNiches"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      fingerprint: v.string(),
      label: v.string(),
      gateTerms: v.array(v.string()),
      ads: v.array(
        v.object({
          id: v.string(),
          pageName: v.string(),
          body: v.string(),
          activeDays: v.number(),
          searchTerm: v.optional(v.string()),
          destinationUrl: v.optional(v.string()),
        }),
      ),
      existingFresh: v.boolean(),
      existingCreatedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const niche = await ctx.db.get(args.nicheId);
    if (!niche) return null;
    const gateTerms = flattenedGateTerms(niche);
    const fingerprint = nicheFingerprint({ label: niche.label, gateTerms });

    const existing = await ctx.db
      .query("radarNicheAdRelevance")
      .withIndex("by_niche", (q) => q.eq("nicheId", args.nicheId))
      .unique();
    const existingFresh = Boolean(
      existing &&
        existing.fingerprint === fingerprint &&
        existing.expiresAt > args.now,
    );

    const links = await ctx.db
      .query("radarNicheAds")
      .withIndex("by_niche", (q) => q.eq("nicheId", args.nicheId))
      .take(400);

    const ads = [];
    for (const link of links) {
      const ad = await ctx.db.get(link.adId);
      if (!ad) continue;
      const body = ad.body?.trim();
      if (!body) continue;
      if (
        !passesNicheAdGate(
          {
            pageName: ad.pageName,
            body,
            mediaUrls: ad.mediaUrls,
            destinationUrl: ad.destinationUrl,
            searchTerm: ad.searchTerm,
          },
          gateTerms,
        )
      ) {
        continue;
      }
      ads.push({
        id: ad._id as string,
        pageName: ad.pageName,
        body,
        activeDays: activeDays(ad.startedAt, ad.lastSeenAt),
        searchTerm: ad.searchTerm,
        destinationUrl: ad.destinationUrl,
      });
      if (ads.length >= MAX_ADS_TO_RANK) break;
    }

    return {
      fingerprint,
      label: niche.label,
      gateTerms,
      ads,
      existingFresh,
      existingCreatedAt: existing?.createdAt,
    };
  },
});

export const saveNicheRelevance = internalMutation({
  args: {
    nicheId: v.id("radarNiches"),
    fingerprint: v.string(),
    ranked: v.array(
      v.object({
        adId: v.id("radarAds"),
        score: v.number(),
        reason: v.optional(v.string()),
      }),
    ),
    droppedAdIds: v.array(v.id("radarAds")),
    model: v.optional(v.string()),
  },
  returns: v.id("radarNicheAdRelevance"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const ranked = args.ranked.map((r) => ({
      ...r,
      score: clampScore(r.score),
    }));
    const existing = await ctx.db
      .query("radarNicheAdRelevance")
      .withIndex("by_niche", (q) => q.eq("nicheId", args.nicheId))
      .unique();
    const doc = {
      nicheId: args.nicheId,
      fingerprint: args.fingerprint,
      ranked,
      droppedAdIds: args.droppedAdIds,
      model: args.model,
      createdAt: now,
      expiresAt: now + NICHE_AD_RELEVANCE_TTL_MS,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("radarNicheAdRelevance", doc);
  },
});
