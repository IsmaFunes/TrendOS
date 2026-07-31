/**
 * Meta Ad Library ingest + queries (Argentina MVP).
 * Scrape runs in an external worker; Convex stores and serves ads.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { getCurrentUserOrNull } from "../lib/auth";
import { passesNicheAdGate } from "./adRelevance";
import { profileFingerprint } from "./geminiAdsCore";

const AR = "AR";

export const OFFER_HOOK_SEEDS = [
  "envio gratis",
  "2x1",
  "cuotas sin interes",
  "tres por uno",
  "uno de regalo",
] as const;

const adReturnValidator = v.object({
  _id: v.id("radarAds"),
  _creationTime: v.number(),
  externalAdId: v.string(),
  pageId: v.string(),
  pageName: v.string(),
  country: v.string(),
  platforms: v.array(v.string()),
  body: v.optional(v.string()),
  cta: v.optional(v.string()),
  snapshotUrl: v.optional(v.string()),
  mediaUrls: v.array(v.string()),
  videoUrl: v.optional(v.string()),
  destinationUrl: v.optional(v.string()),
  storeId: v.optional(v.id("radarStores")),
  searchTerm: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  lastSeenAt: v.number(),
  isActive: v.boolean(),
  metadataJson: v.optional(v.string()),
  createdAt: v.number(),
  activeDays: v.optional(v.number()),
  rankScore: v.optional(v.number()),
  rankReason: v.optional(v.string()),
});

const scrapedAdValidator = v.object({
  externalAdId: v.string(),
  pageId: v.string(),
  pageName: v.string(),
  platforms: v.optional(v.array(v.string())),
  body: v.optional(v.string()),
  cta: v.optional(v.string()),
  snapshotUrl: v.optional(v.string()),
  mediaUrls: v.optional(v.array(v.string())),
  videoUrl: v.optional(v.string()),
  destinationUrl: v.optional(v.string()),
  searchTerm: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  isActive: v.optional(v.boolean()),
  metadataJson: v.optional(v.string()),
});

type ScrapedAd = {
  externalAdId: string;
  pageId: string;
  pageName: string;
  platforms?: string[];
  body?: string;
  cta?: string;
  snapshotUrl?: string;
  mediaUrls?: string[];
  videoUrl?: string;
  destinationUrl?: string;
  searchTerm?: string;
  startedAt?: number;
  isActive?: boolean;
  metadataJson?: string;
};

function activeDays(startedAt: number | undefined, lastSeenAt: number): number {
  if (!startedAt) return 0;
  return Math.max(
    0,
    Math.floor((lastSeenAt - startedAt) / (24 * 60 * 60 * 1000)),
  );
}

/** Ads without creative/copy (or with catalog placeholders) stay out of the feed. */
function isDisplayableAd(ad: {
  pageName: string;
  body?: string;
  mediaUrls: string[];
}): boolean {
  if (!ad.mediaUrls.some((u) => /^https?:\/\//i.test(u))) return false;
  const body = ad.body?.trim();
  if (!body || /\{\{\s*[\w.]+\s*\}\}/.test(body)) return false;
  if (!ad.pageName.trim() || ad.pageName === "Unknown page") return false;
  return true;
}

function nicheKeywordsForGate(
  niche: { keywords: string[]; scrapeTerms?: string[] } | null,
  profileKeywords?: string[],
): string[] {
  return [
    ...(profileKeywords ?? []),
    ...(niche?.keywords ?? []),
    ...(niche?.scrapeTerms ?? []),
  ];
}

function sanitizeBody(body: string | undefined): string | undefined {
  const t = body?.trim();
  if (!t) return undefined;
  if (/\{\{\s*[\w.]+\s*\}\}/.test(t)) return undefined;
  return t;
}

function normalizeDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function detectPlatform(
  destinationUrl: string | undefined,
): "shopify" | "tiendanube" | "mercadolibre" | "custom" {
  const u = (destinationUrl ?? "").toLowerCase();
  if (u.includes("mercadolibre.") || u.includes("mercado libre")) {
    return "mercadolibre";
  }
  if (u.includes("mitiendanube") || u.includes("tiendanube")) {
    return "tiendanube";
  }
  if (u.includes("myshopify.com") || u.includes("/cdn/shop/")) {
    return "shopify";
  }
  return "custom";
}

async function linkAdToNiche(
  ctx: MutationCtx,
  nicheId: Id<"radarNiches">,
  adId: Id<"radarAds">,
  searchTerm: string | undefined,
  now: number,
): Promise<boolean> {
  const existing = await ctx.db
    .query("radarNicheAds")
    .withIndex("by_niche_ad", (q) =>
      q.eq("nicheId", nicheId).eq("adId", adId),
    )
    .unique();
  if (existing) return false;
  await ctx.db.insert("radarNicheAds", {
    nicheId,
    adId,
    searchTerm,
    linkedAt: now,
  });
  return true;
}

async function upsertAdsBatch(
  ctx: MutationCtx,
  country: string,
  ads: ScrapedAd[],
  nicheId?: Id<"radarNiches">,
): Promise<{ upserted: number; advertisersTouched: number; linked: number }> {
  if (country !== AR) {
    throw new Error("MVP only supports country=AR");
  }
  const now = Date.now();
  let upserted = 0;
  let linked = 0;
  const pageCounts = new Map<
    string,
    { pageName: string; active: number; total: number }
  >();
  const nicheDoc = nicheId ? await ctx.db.get(nicheId) : null;
  const gateKeywords = nicheKeywordsForGate(nicheDoc, nicheDoc?.keywords);

  for (const ad of ads) {
    const existing = await ctx.db
      .query("radarAds")
      .withIndex("by_external", (q) => q.eq("externalAdId", ad.externalAdId))
      .unique();

    let storeId: Id<"radarStores"> | undefined;
    const domain = normalizeDomain(ad.destinationUrl);
    if (domain) {
      const store = await ctx.db
        .query("radarStores")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .unique();
      const platform = detectPlatform(ad.destinationUrl);
      if (store) {
        storeId = store._id;
        await ctx.db.patch(store._id, { lastSeenAt: now, platform });
      } else {
        storeId = await ctx.db.insert("radarStores", {
          domain,
          platform,
          country,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    }

    const isActive = ad.isActive ?? true;
    const mediaUrls = (ad.mediaUrls ?? []).filter((u) =>
      /^https?:\/\//i.test(u),
    );
    const videoUrl =
      typeof ad.videoUrl === "string" && /^https?:\/\//i.test(ad.videoUrl)
        ? ad.videoUrl
        : undefined;
    const body = sanitizeBody(ad.body);
    const payload = {
      pageId: ad.pageId,
      pageName: ad.pageName,
      country,
      platforms: ad.platforms ?? [],
      body,
      cta: ad.cta,
      snapshotUrl: ad.snapshotUrl,
      mediaUrls,
      videoUrl,
      destinationUrl: ad.destinationUrl,
      storeId,
      searchTerm: ad.searchTerm,
      startedAt: ad.startedAt,
      lastSeenAt: now,
      isActive,
      metadataJson: ad.metadataJson,
    };

    let adId: Id<"radarAds">;
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      adId = existing._id;
    } else {
      adId = await ctx.db.insert("radarAds", {
        externalAdId: ad.externalAdId,
        ...payload,
        createdAt: now,
      });
    }
    upserted += 1;

    if (
      nicheId &&
      isDisplayableAd({ pageName: ad.pageName, body, mediaUrls }) &&
      passesNicheAdGate(
        {
          pageName: ad.pageName,
          body,
          mediaUrls,
          destinationUrl: ad.destinationUrl,
          searchTerm: ad.searchTerm,
        },
        gateKeywords,
      )
    ) {
      const didLink = await linkAdToNiche(
        ctx,
        nicheId,
        adId,
        ad.searchTerm,
        now,
      );
      if (didLink) linked += 1;
    }

    const prev = pageCounts.get(ad.pageId) ?? {
      pageName: ad.pageName,
      active: 0,
      total: 0,
    };
    prev.total += 1;
    if (isActive) prev.active += 1;
    prev.pageName = ad.pageName;
    pageCounts.set(ad.pageId, prev);
  }

  let advertisersTouched = 0;
  for (const [pageId, counts] of pageCounts) {
    const existing = await ctx.db
      .query("radarAdvertisers")
      .withIndex("by_page", (q) => q.eq("pageId", pageId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        pageName: counts.pageName,
        country,
        activeAdCount: Math.max(existing.activeAdCount, counts.active),
        totalAdCount: existing.totalAdCount + counts.total,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.insert("radarAdvertisers", {
        pageId,
        pageName: counts.pageName,
        country,
        activeAdCount: counts.active,
        totalAdCount: counts.total,
        lastSeenAt: now,
        createdAt: now,
      });
    }
    advertisersTouched += 1;
  }

  if (nicheId) {
    const niche = await ctx.db.get(nicheId);
    if (niche) {
      const total = (
        await ctx.db
          .query("radarNicheAds")
          .withIndex("by_niche", (q) => q.eq("nicheId", nicheId))
          .take(1000)
      ).length;
      await ctx.db.patch(nicheId, {
        adCount: total,
        lastScrapedAt: now,
        status: total > 0 ? "ready" : niche.status,
        updatedAt: now,
      });
    }
  }

  return { upserted, advertisersTouched, linked };
}

export const ingestScrapedAds = internalMutation({
  args: {
    country: v.optional(v.string()),
    nicheId: v.optional(v.id("radarNiches")),
    ads: v.array(scrapedAdValidator),
  },
  returns: v.object({
    upserted: v.number(),
    advertisersTouched: v.number(),
    linked: v.number(),
  }),
  handler: async (ctx, args) => {
    return await upsertAdsBatch(
      ctx,
      (args.country ?? AR).toUpperCase(),
      args.ads,
      args.nicheId,
    );
  },
});

/** Worker ingest — requires META_ADS_INGEST_SECRET in Convex env. */
export const ingestScrapedAdsFromWorker = mutation({
  args: {
    secret: v.string(),
    country: v.optional(v.string()),
    nicheId: v.optional(v.id("radarNiches")),
    ads: v.array(scrapedAdValidator),
  },
  returns: v.object({
    upserted: v.number(),
    advertisersTouched: v.number(),
    linked: v.number(),
  }),
  handler: async (ctx, args) => {
    const expected = process.env.META_ADS_INGEST_SECRET?.trim();
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized ingest");
    }
    return await upsertAdsBatch(
      ctx,
      (args.country ?? AR).toUpperCase(),
      args.ads,
      args.nicheId,
    );
  },
});

export const listAdsForUser = query({
  args: {
    search: v.optional(v.string()),
    sort: v.optional(
      v.union(
        v.literal("personalized"),
        v.literal("recent"),
        v.literal("active_days"),
      ),
    ),
    limit: v.optional(v.number()),
    /** Client clock for ranking cache freshness (no Date.now in queries). */
    now: v.optional(v.number()),
  },
  returns: v.array(adReturnValidator),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile?.nicheId) return [];

    const limit = Math.min(args.limit ?? 48, 100);
    const links = await ctx.db
      .query("radarNicheAds")
      .withIndex("by_niche", (q) => q.eq("nicheId", profile.nicheId!))
      .take(400);

    const excluded = (profile.excludedKeywords ?? []).map((k) =>
      k.toLowerCase(),
    );
    const search = args.search?.trim().toLowerCase();
    const sort = args.sort ?? "personalized";
    const now = args.now ?? 0;

    const fingerprint = profileFingerprint({
      businessName: profile.businessName,
      description: profile.description,
      nicheKeywords: profile.nicheKeywords,
      excludedKeywords: profile.excludedKeywords,
      goal: profile.goal,
      notes: profile.notes,
      channels: profile.channels,
    });
    const niche = await ctx.db.get(profile.nicheId!);
    const gateKeywords = nicheKeywordsForGate(
      niche,
      profile.nicheKeywords,
    );
    const rankingDoc =
      sort === "personalized" && now > 0
        ? await ctx.db
            .query("radarAdRankings")
            .withIndex("by_user_niche", (q) =>
              q.eq("userId", user._id).eq("nicheId", profile.nicheId!),
            )
            .unique()
        : null;
    const ranking =
      rankingDoc &&
      rankingDoc.profileFingerprint === fingerprint &&
      rankingDoc.expiresAt > now
        ? rankingDoc
        : null;
    const dropped = new Set(ranking?.droppedAdIds.map(String) ?? []);
    const scoreById = new Map(
      ranking?.ranked.map((r) => [String(r.adId), r]) ?? [],
    );

    const ads = [];
    for (const link of links) {
      const ad = await ctx.db.get(link.adId);
      if (!ad || ad.country !== AR) continue;
      if (!isDisplayableAd(ad)) continue;
      if (
        !passesNicheAdGate(
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
        continue;
      }
      if (dropped.has(String(ad._id))) continue;
      const hay =
        `${ad.pageName} ${ad.body ?? ""} ${ad.searchTerm ?? ""}`.toLowerCase();
      if (excluded.some((ex) => hay.includes(ex))) continue;
      if (search && !hay.includes(search)) continue;
      const ranked = scoreById.get(String(ad._id));
      // When a fresh ranking exists, only show ads Gemini kept with decent score.
      if (sort === "personalized" && ranking) {
        if (!ranked || ranked.score < 45) continue;
      }
      ads.push({
        ...ad,
        activeDays: activeDays(ad.startedAt, ad.lastSeenAt),
        rankScore: ranked?.score,
        rankReason: ranked?.reason,
      });
    }

    ads.sort((a, b) => {
      if (sort === "personalized" && ranking) {
        const sa = a.rankScore ?? -1;
        const sb = b.rankScore ?? -1;
        if (sb !== sa) return sb - sa;
      }
      if (sort === "active_days") {
        return (b.activeDays ?? 0) - (a.activeDays ?? 0);
      }
      return b.lastSeenAt - a.lastSeenAt;
    });

    return ads.slice(0, limit);
  },
});

/** UI helper: niche scrape status for empty states. */
export const getAdsFeedState = query({
  args: {},
  returns: v.object({
    nicheId: v.union(v.id("radarNiches"), v.null()),
    nicheLabel: v.optional(v.string()),
    status: v.union(
      v.literal("no_niche"),
      v.literal("pending_scrape"),
      v.literal("scraping"),
      v.literal("ready"),
      v.literal("empty"),
    ),
    adCount: v.number(),
  }),
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) {
      return { nicheId: null, status: "no_niche" as const, adCount: 0 };
    }
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile?.nicheId) {
      return { nicheId: null, status: "no_niche" as const, adCount: 0 };
    }
    const niche = await ctx.db.get(profile.nicheId);
    if (!niche) {
      return { nicheId: null, status: "no_niche" as const, adCount: 0 };
    }
    if (niche.status === "pending_scrape" || niche.status === "scraping") {
      return {
        nicheId: niche._id,
        nicheLabel: niche.label,
        status: niche.status,
        adCount: niche.adCount,
      };
    }
    if (niche.adCount === 0) {
      return {
        nicheId: niche._id,
        nicheLabel: niche.label,
        status: "empty" as const,
        adCount: 0,
      };
    }
    return {
      nicheId: niche._id,
      nicheLabel: niche.label,
      status: "ready" as const,
      adCount: niche.adCount,
    };
  },
});

export const getAd = query({
  args: { adId: v.id("radarAds") },
  returns: v.union(adReturnValidator, v.null()),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const ad = await ctx.db.get(args.adId);
    if (!ad || ad.country !== AR) return null;
    return {
      ...ad,
      activeDays: activeDays(ad.startedAt, ad.lastSeenAt),
    };
  },
});

export const listScrapeSeedTerms = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      term: v.string(),
      country: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const seeds = new Set<string>([...OFFER_HOOK_SEEDS]);
    const profiles = await ctx.db.query("businessProfiles").take(50);
    for (const p of profiles) {
      for (const kw of p.nicheKeywords ?? []) {
        const t = kw.trim().toLowerCase();
        if (t) seeds.add(t);
      }
    }
    return [...seeds].slice(0, 40).map((term) => ({
      term,
      country: AR,
    }));
  },
});
