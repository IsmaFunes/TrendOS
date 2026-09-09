/**
 * Meta Ad Library ingest + queries (Argentina MVP).
 * Scrape runs in an external worker; Convex stores and serves ads.
 */

import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getCurrentUserOrNull } from "../lib/auth";
import {
  normalizeForSubstringMatch,
  passesNicheAdGate,
} from "./adRelevance";
import { flattenedGateTerms, MIN_ADS_READY } from "./niches";
import { scoreStoreQuality } from "./investigate";

/** Ads below this Gemini relevance score are never shown, any sort mode. */
const MIN_RELEVANCE_SCORE = 45;

const AR = "AR";
/** Countries the scraper is allowed to ingest ads for (convex/admin/seedNicheCatalog.ts). */
export const SCRAPE_COUNTRIES = ["AR", "US", "BR", "MX", "ES"] as const;

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
  /** Opportunity ranking: days active + advertiser's currently-active ad count + total ad count. */
  storeQualityScore: v.optional(v.number()),
  storeQualityLabel: v.optional(v.string()),
  advertiserActiveAdCount: v.optional(v.number()),
  /** How many creative variants Meta reports collated under this ad — a live ad-spend/testing-scale signal. */
  collationCount: v.optional(v.number()),
  /** Facebook page info, straight from the Ad Library payload — for a "how is this store doing" view alongside the derived quality score. */
  pageLikeCount: v.optional(v.number()),
  pageCategories: v.optional(v.array(v.string())),
  pageProfileUri: v.optional(v.string()),
  pageProfilePictureUrl: v.optional(v.string()),
  pageIsDeleted: v.optional(v.boolean()),
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
  collationCount: v.optional(v.number()),
  pageLikeCount: v.optional(v.number()),
  pageCategories: v.optional(v.array(v.string())),
  pageProfileUri: v.optional(v.string()),
  pageProfilePictureUrl: v.optional(v.string()),
  pageIsDeleted: v.optional(v.boolean()),
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
  collationCount?: number;
  pageLikeCount?: number;
  pageCategories?: string[];
  pageProfileUri?: string;
  pageProfilePictureUrl?: string;
  pageIsDeleted?: boolean;
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
  if (!(SCRAPE_COUNTRIES as readonly string[]).includes(country)) {
    throw new Error(`Unsupported scrape country: ${country}`);
  }
  const now = Date.now();
  let upserted = 0;
  let linked = 0;
  const pageCounts = new Map<
    string,
    {
      pageName: string;
      active: number;
      total: number;
      pageLikeCount?: number;
      pageCategories?: string[];
      pageProfileUri?: string;
      pageProfilePictureUrl?: string;
      pageIsDeleted?: boolean;
    }
  >();
  const nicheDoc = nicheId ? await ctx.db.get(nicheId) : null;
  const gateKeywords = nicheDoc ? flattenedGateTerms(nicheDoc) : [];

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
      collationCount: ad.collationCount,
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
    // Any ad in the batch reporting a real value wins — a null/undefined
    // from a scrape that didn't happen to carry this field on that
    // particular ad shouldn't erase a value another ad for the same page
    // already provided in this same batch.
    if (ad.pageLikeCount != null) prev.pageLikeCount = ad.pageLikeCount;
    if (ad.pageCategories != null) prev.pageCategories = ad.pageCategories;
    if (ad.pageProfileUri != null) prev.pageProfileUri = ad.pageProfileUri;
    if (ad.pageProfilePictureUrl != null) {
      prev.pageProfilePictureUrl = ad.pageProfilePictureUrl;
    }
    if (ad.pageIsDeleted != null) prev.pageIsDeleted = ad.pageIsDeleted;
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
        // This batch's value wins when it reported one — Meta payloads
        // vary per-request in which fields they include — otherwise the
        // previously known value is kept rather than erased.
        pageLikeCount: counts.pageLikeCount ?? existing.pageLikeCount,
        pageCategories: counts.pageCategories ?? existing.pageCategories,
        pageProfileUri: counts.pageProfileUri ?? existing.pageProfileUri,
        pageProfilePictureUrl:
          counts.pageProfilePictureUrl ?? existing.pageProfilePictureUrl,
        pageIsDeleted: counts.pageIsDeleted ?? existing.pageIsDeleted,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.insert("radarAdvertisers", {
        pageId,
        pageName: counts.pageName,
        country,
        activeAdCount: counts.active,
        totalAdCount: counts.total,
        pageLikeCount: counts.pageLikeCount,
        pageCategories: counts.pageCategories,
        pageProfileUri: counts.pageProfileUri,
        pageProfilePictureUrl: counts.pageProfilePictureUrl,
        pageIsDeleted: counts.pageIsDeleted,
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
        status: total >= MIN_ADS_READY ? "ready" : "pending_scrape",
        updatedAt: now,
      });
      // New ads changed the niche's ad pool — refresh the shared relevance
      // pass so listAdsForUser's mandatory gate has an up-to-date judgment
      // instead of serving a stale one (or none) until the next scrape.
      // force:true because the freshness cache is keyed on the niche's
      // fingerprint (gate terms/label), which a re-scrape with the same
      // curated terms doesn't change — without force, newly-linked ads
      // would silently never get judged until the 24h TTL expires.
      if (linked > 0) {
        await ctx.scheduler.runAfter(
          0,
          internal.radar.geminiAds.refreshNicheAdRelevance,
          { nicheId, force: true },
        );
      }
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
        v.literal("quality"),
        v.literal("recent"),
        v.literal("active_days"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  returns: v.array(adReturnValidator),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile || profile.nicheIds.length === 0) return [];

    const search = args.search
      ? normalizeForSubstringMatch(args.search.trim())
      : undefined;
    // A real browsing experience over the relevant pool, ranked by quality
    // — not a forced top-10 shortlist.
    const limit = Math.min(args.limit ?? 48, 100);
    const sort = args.sort ?? "quality";

    const ads = [];
    const seenAdIds = new Set<string>();
    for (const nicheId of profile.nicheIds) {
      const niche = await ctx.db.get(nicheId);
      if (!niche) continue;
      const gateKeywords = flattenedGateTerms(niche);

      // Mandatory, niche-shared relevance gate — an ad the niche's
      // relevance pass hasn't explicitly kept (score >= MIN_RELEVANCE_SCORE)
      // is never shown, in ANY sort mode. If the niche has no relevance
      // pass yet, it contributes nothing (getAdsFeedState surfaces this as
      // "relevance_pending") rather than falling back to the heuristic gate
      // alone.
      const relevance = await ctx.db
        .query("radarNicheAdRelevance")
        .withIndex("by_niche", (q) => q.eq("nicheId", nicheId))
        .unique();
      if (!relevance) continue;
      const scoreById = new Map(
        relevance.ranked.map((r) => [String(r.adId), r]),
      );

      const links = await ctx.db
        .query("radarNicheAds")
        .withIndex("by_niche", (q) => q.eq("nicheId", nicheId))
        .take(400);

      for (const link of links) {
        const adKey = String(link.adId);
        if (seenAdIds.has(adKey)) continue;
        const ad = await ctx.db.get(link.adId);
        if (!ad) continue;
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
        const ranked = scoreById.get(adKey);
        if (!ranked || ranked.score < MIN_RELEVANCE_SCORE) continue;
        const hay = normalizeForSubstringMatch(
          `${ad.pageName} ${ad.body ?? ""} ${ad.searchTerm ?? ""}`,
        );
        if (search && !hay.includes(search)) continue;
        seenAdIds.add(adKey);
        const adActiveDays = activeDays(ad.startedAt, ad.lastSeenAt);
        const advertiser = await ctx.db
          .query("radarAdvertisers")
          .withIndex("by_page", (q) => q.eq("pageId", ad.pageId))
          .unique();
        const store = ad.storeId ? await ctx.db.get(ad.storeId) : null;
        const quality = scoreStoreQuality({
          hasStore: Boolean(store),
          platform: store?.platform,
          activeAdCount: advertiser?.activeAdCount,
          totalAdCount: advertiser?.totalAdCount,
          adActiveDays,
          pageLikeCount: advertiser?.pageLikeCount,
          pageIsDeleted: advertiser?.pageIsDeleted,
        });
        ads.push({
          ...ad,
          activeDays: adActiveDays,
          rankScore: ranked.score,
          rankReason: ranked.reason,
          storeQualityScore: quality.score,
          storeQualityLabel: quality.label,
          advertiserActiveAdCount: advertiser?.activeAdCount,
          pageLikeCount: advertiser?.pageLikeCount,
          pageCategories: advertiser?.pageCategories,
          pageProfileUri: advertiser?.pageProfileUri,
          pageProfilePictureUrl: advertiser?.pageProfilePictureUrl,
          pageIsDeleted: advertiser?.pageIsDeleted,
        });
      }
    }

    ads.sort((a, b) => {
      if (sort === "quality") {
        const sa = a.storeQualityScore ?? 0;
        const sb = b.storeQualityScore ?? 0;
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

const feedNicheStatusValidator = v.union(
  v.literal("pending_scrape"),
  v.literal("scraping"),
  v.literal("relevance_pending"),
  v.literal("ready"),
  v.literal("empty"),
);

async function nicheFeedState(
  ctx: { db: QueryCtx["db"] },
  niche: { _id: Id<"radarNiches">; label: string; status: string; adCount: number },
): Promise<{
  nicheId: Id<"radarNiches">;
  nicheLabel: string;
  status: "pending_scrape" | "scraping" | "relevance_pending" | "ready" | "empty";
  adCount: number;
}> {
  if (niche.status === "pending_scrape" || niche.status === "scraping") {
    return {
      nicheId: niche._id,
      nicheLabel: niche.label,
      status: niche.status,
      adCount: niche.adCount,
    };
  }
  // niche.status === "ready" — but the feed itself is gated on a completed
  // relevance pass, which can lag behind niche readiness (e.g. right after
  // Gemini is momentarily unavailable).
  const relevance = await ctx.db
    .query("radarNicheAdRelevance")
    .withIndex("by_niche", (q) => q.eq("nicheId", niche._id))
    .unique();
  if (!relevance) {
    return {
      nicheId: niche._id,
      nicheLabel: niche.label,
      status: "relevance_pending",
      adCount: niche.adCount,
    };
  }
  const keptCount = relevance.ranked.filter(
    (r) => r.score >= MIN_RELEVANCE_SCORE,
  ).length;
  return {
    nicheId: niche._id,
    nicheLabel: niche.label,
    status: keptCount === 0 ? "empty" : "ready",
    adCount: keptCount,
  };
}

/** UI helper: per-niche scrape + relevance-pass status for empty states. */
export const getAdsFeedState = query({
  args: {},
  returns: v.object({
    niches: v.array(
      v.object({
        nicheId: v.id("radarNiches"),
        nicheLabel: v.string(),
        status: feedNicheStatusValidator,
        adCount: v.number(),
      }),
    ),
    status: v.union(v.literal("no_niche"), feedNicheStatusValidator),
    nicheLabel: v.optional(v.string()),
    adCount: v.number(),
  }),
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) {
      return { niches: [], status: "no_niche" as const, adCount: 0 };
    }
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile || profile.nicheIds.length === 0) {
      return { niches: [], status: "no_niche" as const, adCount: 0 };
    }

    const niches = [];
    for (const nicheId of profile.nicheIds) {
      const niche = await ctx.db.get(nicheId);
      if (!niche) continue;
      niches.push(await nicheFeedState(ctx, niche));
    }
    if (niches.length === 0) {
      return { niches: [], status: "no_niche" as const, adCount: 0 };
    }

    // Show ads as soon as ANY of the user's niches is ready — only surface
    // a waiting/empty message when none of them are.
    const ready = niches.find((n) => n.status === "ready");
    if (ready) {
      const adCount = niches.reduce(
        (sum, n) => sum + (n.status === "ready" ? n.adCount : 0),
        0,
      );
      return { niches, status: "ready" as const, nicheLabel: ready.nicheLabel, adCount };
    }
    const first = niches[0];
    return {
      niches,
      status: first.status,
      nicheLabel: first.nicheLabel,
      adCount: first.adCount,
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
    if (!ad) return null;

    const adActiveDays = activeDays(ad.startedAt, ad.lastSeenAt);
    const advertiser = await ctx.db
      .query("radarAdvertisers")
      .withIndex("by_page", (q) => q.eq("pageId", ad.pageId))
      .unique();
    const store = ad.storeId ? await ctx.db.get(ad.storeId) : null;
    const quality = scoreStoreQuality({
      hasStore: Boolean(store),
      platform: store?.platform,
      activeAdCount: advertiser?.activeAdCount,
      totalAdCount: advertiser?.totalAdCount,
      adActiveDays,
      pageLikeCount: advertiser?.pageLikeCount,
      pageIsDeleted: advertiser?.pageIsDeleted,
    });

    return {
      ...ad,
      activeDays: adActiveDays,
      storeQualityScore: quality.score,
      storeQualityLabel: quality.label,
      advertiserActiveAdCount: advertiser?.activeAdCount,
      pageLikeCount: advertiser?.pageLikeCount,
      pageCategories: advertiser?.pageCategories,
      pageProfileUri: advertiser?.pageProfileUri,
      pageProfilePictureUrl: advertiser?.pageProfilePictureUrl,
      pageIsDeleted: advertiser?.pageIsDeleted,
    };
  },
});

