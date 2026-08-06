/**
 * Cached per-user Gemini rankings for niche ads.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { getCurrentUserOrNull } from "../lib/auth";
import { passesNicheAdGate } from "./adRelevance";
import {
  AD_RANKING_TTL_MS,
  MAX_ADS_TO_RANK,
  profileFingerprint,
  type ProfileForAds,
} from "./geminiAdsCore";
import { clampScore } from "./metrics";

const AR = "AR";

function activeDays(startedAt: number | undefined, lastSeenAt: number): number {
  if (!startedAt) return 0;
  return Math.max(
    0,
    Math.floor((lastSeenAt - startedAt) / (24 * 60 * 60 * 1000)),
  );
}

export const getMyRankingState = query({
  args: { now: v.number() },
  returns: v.object({
    status: v.union(
      v.literal("no_user"),
      v.literal("no_niche"),
      v.literal("missing"),
      v.literal("stale"),
      v.literal("fresh"),
    ),
    expiresAt: v.optional(v.number()),
    rankedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) {
      return { status: "no_user" as const, rankedCount: 0 };
    }
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile?.nicheId) {
      return { status: "no_niche" as const, rankedCount: 0 };
    }
    const ranking = await ctx.db
      .query("radarAdRankings")
      .withIndex("by_user_niche", (q) =>
        q.eq("userId", user._id).eq("nicheId", profile.nicheId!),
      )
      .unique();
    if (!ranking) {
      return { status: "missing" as const, rankedCount: 0 };
    }
    const fp = profileFingerprint({
      businessName: profile.businessName,
      description: profile.description,
      nicheKeywords: profile.nicheKeywords,
      excludedKeywords: profile.excludedKeywords,
      goal: profile.goal,
      notes: profile.notes,
      channels: profile.channels,
    });
    if (
      ranking.profileFingerprint !== fp ||
      ranking.expiresAt <= args.now
    ) {
      return {
        status: "stale" as const,
        expiresAt: ranking.expiresAt,
        rankedCount: ranking.ranked.length,
      };
    }
    return {
      status: "fresh" as const,
      expiresAt: ranking.expiresAt,
      rankedCount: ranking.ranked.length,
    };
  },
});

export const loadRankingContext = internalQuery({
  args: { userId: v.id("users"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      nicheId: v.id("radarNiches"),
      fingerprint: v.string(),
      profile: v.object({
        businessName: v.string(),
        description: v.optional(v.string()),
        nicheKeywords: v.optional(v.array(v.string())),
        excludedKeywords: v.optional(v.array(v.string())),
        goal: v.optional(v.string()),
        notes: v.optional(v.string()),
        channels: v.optional(v.array(v.string())),
      }),
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
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!profile?.nicheId) return null;

    const profileForAds: ProfileForAds = {
      businessName: profile.businessName,
      description: profile.description,
      nicheKeywords: profile.nicheKeywords,
      excludedKeywords: profile.excludedKeywords,
      goal: profile.goal,
      notes: profile.notes,
      channels: profile.channels,
    };
    const fingerprint = profileFingerprint(profileForAds);
    const niche = await ctx.db.get(profile.nicheId);
    const gateKeywords = [
      ...(profile.nicheKeywords ?? []),
      ...(niche?.keywords ?? []),
      ...(niche?.scrapeTerms ?? []),
    ];

    const existing = await ctx.db
      .query("radarAdRankings")
      .withIndex("by_user_niche", (q) =>
        q.eq("userId", args.userId).eq("nicheId", profile.nicheId!),
      )
      .unique();
    const existingFresh = Boolean(
      existing &&
        existing.profileFingerprint === fingerprint &&
        existing.expiresAt > args.now,
    );

    const links = await ctx.db
      .query("radarNicheAds")
      .withIndex("by_niche", (q) => q.eq("nicheId", profile.nicheId!))
      .take(400);

    const ads = [];
    for (const link of links) {
      const ad = await ctx.db.get(link.adId);
      if (!ad || ad.country !== AR) continue;
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
          gateKeywords,
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
      nicheId: profile.nicheId,
      fingerprint,
      profile: {
        businessName: profile.businessName,
        description: profile.description,
        nicheKeywords: profile.nicheKeywords,
        excludedKeywords: profile.excludedKeywords,
        goal: profile.goal,
        notes: profile.notes,
        channels: profile.channels,
      },
      ads,
      existingFresh,
      existingCreatedAt: existing?.createdAt,
    };
  },
});

export const saveRanking = internalMutation({
  args: {
    userId: v.id("users"),
    nicheId: v.id("radarNiches"),
    profileFingerprint: v.string(),
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
  returns: v.id("radarAdRankings"),
  handler: async (ctx, args) => {
    const now = Date.now();
    // score is caller-clamped (parseRankingResponse) before this internal
    // mutation is reached, but v.number() itself has no bound — re-clamp
    // here so a future call site can't silently write a bad score.
    const ranked = args.ranked.map((r) => ({
      ...r,
      score: clampScore(r.score),
    }));
    const existing = await ctx.db
      .query("radarAdRankings")
      .withIndex("by_user_niche", (q) =>
        q.eq("userId", args.userId).eq("nicheId", args.nicheId),
      )
      .unique();
    const doc = {
      userId: args.userId,
      nicheId: args.nicheId,
      profileFingerprint: args.profileFingerprint,
      ranked,
      droppedAdIds: args.droppedAdIds,
      model: args.model,
      createdAt: now,
      expiresAt: now + AD_RANKING_TTL_MS,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("radarAdRankings", doc);
  },
});

export const loadNicheForEnrich = internalQuery({
  args: {
    nicheId: v.id("radarNiches"),
    jobId: v.optional(v.id("radarNicheScrapeJobs")),
  },
  returns: v.union(
    v.null(),
    v.object({
      nicheId: v.id("radarNiches"),
      keywords: v.array(v.string()),
      scrapeTerms: v.optional(v.array(v.string())),
      label: v.string(),
      jobId: v.optional(v.id("radarNicheScrapeJobs")),
      jobStatus: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const niche = await ctx.db.get(args.nicheId);
    if (!niche) return null;
    let jobStatus: string | undefined;
    if (args.jobId) {
      const job = await ctx.db.get(args.jobId);
      jobStatus = job?.status;
    }
    return {
      nicheId: niche._id,
      keywords: niche.keywords,
      scrapeTerms: niche.scrapeTerms,
      label: niche.label,
      jobId: args.jobId,
      jobStatus,
    };
  },
});

export const applyScrapeTerms = internalMutation({
  args: {
    nicheId: v.id("radarNiches"),
    jobId: v.optional(v.id("radarNicheScrapeJobs")),
    terms: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.nicheId, {
      scrapeTerms: args.terms,
      updatedAt: now,
    });
    if (args.jobId) {
      const job = await ctx.db.get(args.jobId);
      if (job && job.status === "pending") {
        await ctx.db.patch(args.jobId, { terms: args.terms });
      }
    }
    return null;
  },
});
