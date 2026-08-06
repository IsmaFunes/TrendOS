import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireCurrentUser } from "../lib/auth";
import {
  jobStatusValidator,
  jobTypeValidator,
  type DataSource,
  type JobType,
} from "./validators";
import { periodKeyFromTs } from "./metrics";
import { normalizeAlias, slugifyProductName, detectBrandModel } from "./normalize";
import { matchListingToProduct } from "./matching";
import {
  computeFeaturesFromSnapshots,
  saturationFromFeatures,
  type SnapshotRow,
} from "./features";
import { computeOpportunityScore } from "./scoring";
import { seasonalityAt } from "./seasonality";
import {
  createMercadoLibreProvider,
} from "./providers/mercadolibre";
import { resolveMercadoLibreAccessToken } from "./providers/mlAuth";
import {
  expectedRoleCount,
  expectedSourceCount,
  resolveSources,
} from "./providers/registry";
import { structuredLog } from "./http";
import { createAliExpressProviderFromEnv } from "./providers/aliexpress";

async function assertNoParallelJob(
  ctx: MutationCtx,
  type: JobType,
): Promise<void> {
  const running = await ctx.db
    .query("radarJobs")
    .withIndex("by_type_and_status", (q) =>
      q.eq("type", type).eq("status", "RUNNING"),
    )
    .first();
  if (running) {
    throw new Error(`Job ${type} already running`);
  }
}

export const createJob = internalMutation({
  args: {
    type: jobTypeValidator,
    createdBy: v.optional(v.id("users")),
    metadataJson: v.optional(v.string()),
  },
  returns: v.id("radarJobs"),
  handler: async (ctx, args) => {
    await assertNoParallelJob(ctx, args.type);
    return await ctx.db.insert("radarJobs", {
      type: args.type,
      status: "PENDING",
      processedItems: 0,
      successfulItems: 0,
      failedItems: 0,
      metadataJson: args.metadataJson,
      createdAt: Date.now(),
      createdBy: args.createdBy,
    });
  },
});

export const markJobRunning = internalMutation({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: "RUNNING",
      startedAt: Date.now(),
    });
    return null;
  },
});

export const finishJob = internalMutation({
  args: {
    jobId: v.id("radarJobs"),
    status: jobStatusValidator,
    processedItems: v.number(),
    successfulItems: v.number(),
    failedItems: v.number(),
    errorSummary: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: args.status,
      finishedAt: Date.now(),
      processedItems: args.processedItems,
      successfulItems: args.successfulItems,
      failedItems: args.failedItems,
      errorSummary: args.errorSummary,
    });
    return null;
  },
});

export const listJobs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("radarJobs"),
      type: jobTypeValidator,
      status: jobStatusValidator,
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
      processedItems: v.number(),
      successfulItems: v.number(),
      failedItems: v.number(),
      errorSummary: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const limit = args.limit ?? 30;
    const jobs = await ctx.db
      .query("radarJobs")
      .withIndex("by_created")
      .order("desc")
      .take(limit);
    return jobs.map((j) => ({
      _id: j._id,
      type: j.type,
      status: j.status,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      processedItems: j.processedItems,
      successfulItems: j.successfulItems,
      failedItems: j.failedItems,
      errorSummary: j.errorSummary,
      createdAt: j.createdAt,
    }));
  },
});

export const listActiveSearchTerms = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("radarSearchTerms"),
      term: v.string(),
      country: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const terms = await ctx.db
      .query("radarSearchTerms")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
    return terms.map((t) => ({
      _id: t._id,
      term: t.term,
      country: t.country,
    }));
  },
});

export const listTrackedProducts = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("radarProducts"),
      canonicalName: v.string(),
      listings: v.array(
        v.object({
          _id: v.id("radarMarketplaceListings"),
          source: v.string(),
          externalId: v.string(),
          externalUrl: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const products = await ctx.db
      .query("radarProducts")
      .withIndex("by_status", (q) => q.eq("status", "tracked"))
      .collect();
    const result = [];
    for (const p of products) {
      const listings = await ctx.db
        .query("radarMarketplaceListings")
        .withIndex("by_product", (q) => q.eq("productId", p._id))
        .collect();
      result.push({
        _id: p._id,
        canonicalName: p.canonicalName,
        listings: listings
          .filter((l) => l.isActive)
          .map((l) => ({
            _id: l._id,
            source: l.source,
            externalId: l.externalId,
            externalUrl: l.externalUrl,
          })),
      });
    }
    return result;
  },
});

export const upsertListingAndSnapshot = internalMutation({
  args: {
    source: v.string(),
    externalId: v.string(),
    title: v.string(),
    externalUrl: v.optional(v.string()),
    price: v.optional(v.number()),
    originalPrice: v.optional(v.number()),
    currency: v.optional(v.string()),
    sellerId: v.optional(v.string()),
    sellerName: v.optional(v.string()),
    availableQuantity: v.optional(v.number()),
    condition: v.optional(v.string()),
    categoryExternalId: v.optional(v.string()),
    soldQuantity: v.optional(v.number()),
    reviewCount: v.optional(v.number()),
    rating: v.optional(v.number()),
    searchPosition: v.optional(v.number()),
    sellerCount: v.optional(v.number()),
    listingCount: v.optional(v.number()),
    metadataJson: v.optional(v.string()),
    country: v.optional(v.string()),
    /** When set, always attach listing to this product (skip fuzzy create). */
    forceProductId: v.optional(v.id("radarProducts")),
  },
  returns: v.object({
    productId: v.id("radarProducts"),
    listingId: v.id("radarMarketplaceListings"),
    snapshotCreated: v.boolean(),
    reviewQueued: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const source = args.source as DataSource;
    const now = Date.now();
    const periodKey = periodKeyFromTs(now);

    const existingListing = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_source_external", (q) =>
        q.eq("source", source).eq("externalId", args.externalId),
      )
      .unique();

    if (existingListing) {
      await ctx.db.patch(existingListing._id, {
        productId: args.forceProductId ?? existingListing.productId,
        title: args.title,
        currentPrice: args.price,
        originalPrice: args.originalPrice,
        availableQuantity: args.availableQuantity,
        lastSeenAt: now,
        isActive: true,
        externalUrl: args.externalUrl ?? existingListing.externalUrl,
        metadataJson: args.metadataJson,
      });

      const productId = args.forceProductId ?? existingListing.productId;

      const existingSnap = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", productId)
            .eq("source", source)
            .eq("periodKey", periodKey),
        )
        .unique();

      let snapshotCreated = false;
      if (!existingSnap) {
        await ctx.db.insert("radarProductSnapshots", {
          productId,
          listingId: existingListing._id,
          source,
          capturedAt: now,
          periodKey,
          price: args.price,
          originalPrice: args.originalPrice,
          reviewCount: args.reviewCount,
          rating: args.rating,
          soldQuantity: args.soldQuantity,
          availableQuantity: args.availableQuantity,
          searchPosition: args.searchPosition,
          sellerCount: args.sellerCount,
          listingCount: args.listingCount,
          metadataJson: args.metadataJson,
        });
        snapshotCreated = true;
      }

      return {
        productId,
        listingId: existingListing._id,
        snapshotCreated,
        reviewQueued: false,
      };
    }

    let productId: Id<"radarProducts">;
    let reviewQueued = false;

    if (args.forceProductId) {
      productId = args.forceProductId;
    } else {
      // Match to existing product or create new
      const products = await ctx.db.query("radarProducts").take(200);
      const candidates = [];
      for (const p of products) {
        const aliases = await ctx.db
          .query("radarProductAliases")
          .withIndex("by_product", (q) => q.eq("productId", p._id))
          .collect();
        candidates.push({
          productId: p._id,
          canonicalName: p.canonicalName,
          brand: p.brand,
          model: p.model,
          aliases: aliases.map((a) => a.alias),
          categoryId: p.categoryId,
        });
      }

      const match = matchListingToProduct(
        {
          source,
          externalId: args.externalId,
          title: args.title,
        },
        candidates.map((c) => ({
          ...c,
          productId: c.productId as string,
          categoryId: c.categoryId as string | undefined,
        })),
      );

      if (
        match.productId &&
        !match.requiresManualReview &&
        match.confidence >= 0.85
      ) {
        productId = match.productId as Id<"radarProducts">;
      } else {
        const guessed = detectBrandModel(args.title);
        const slugBase = slugifyProductName(args.title);
        let slug = slugBase;
        let n = 1;
        while (
          await ctx.db
            .query("radarProducts")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .unique()
        ) {
          slug = `${slugBase}-${n++}`;
        }
        productId = await ctx.db.insert("radarProducts", {
          canonicalName: args.title.slice(0, 120),
          slug,
          brand: guessed.brand,
          model: guessed.model,
          status: match.requiresManualReview ? "pending_review" : "tracked",
          country: args.country ?? "AR",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("radarProductAliases", {
          productId,
          alias: args.title,
          normalizedAlias: normalizeAlias(args.title),
          source,
          createdAt: now,
        });

        if (match.requiresManualReview && match.productId) {
          await ctx.db.insert("radarReviewQueue", {
            status: "pending",
            candidateProductId: productId,
            existingProductId: match.productId as Id<"radarProducts">,
            matchConfidence: match.confidence,
            matchMethod: match.method,
            explanation: match.explanation,
            proposedAlias: args.title,
            createdAt: now,
          });
          reviewQueued = true;
        }
      }
    }

    const listingId = await ctx.db.insert("radarMarketplaceListings", {
      productId,
      source,
      externalId: args.externalId,
      externalUrl: args.externalUrl,
      title: args.title,
      sellerId: args.sellerId,
      sellerName: args.sellerName,
      currency: args.currency,
      currentPrice: args.price,
      originalPrice: args.originalPrice,
      availableQuantity: args.availableQuantity,
      condition: args.condition,
      categoryExternalId: args.categoryExternalId,
      metadataJson: args.metadataJson,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
    });

    await ctx.db.insert("radarProductSnapshots", {
      productId,
      listingId,
      source,
      capturedAt: now,
      periodKey,
      price: args.price,
      originalPrice: args.originalPrice,
      reviewCount: args.reviewCount,
      rating: args.rating,
      soldQuantity: args.soldQuantity,
      availableQuantity: args.availableQuantity,
      searchPosition: args.searchPosition,
      sellerCount: args.sellerCount,
      listingCount: args.listingCount,
      metadataJson: args.metadataJson,
    });

    return {
      productId,
      listingId,
      snapshotCreated: true,
      reviewQueued,
    };
  },
});

export const writeObservationSnapshot = internalMutation({
  args: {
    productId: v.id("radarProducts"),
    listingId: v.optional(v.id("radarMarketplaceListings")),
    source: v.string(),
    price: v.optional(v.number()),
    originalPrice: v.optional(v.number()),
    reviewCount: v.optional(v.number()),
    rating: v.optional(v.number()),
    soldQuantity: v.optional(v.number()),
    availableQuantity: v.optional(v.number()),
    searchPosition: v.optional(v.number()),
    sellerCount: v.optional(v.number()),
    listingCount: v.optional(v.number()),
    mentionCount: v.optional(v.number()),
    viewCount: v.optional(v.number()),
    searchInterest: v.optional(v.number()),
    isAvailable: v.optional(v.boolean()),
    metadataJson: v.optional(v.string()),
  },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const periodKey = periodKeyFromTs(now);
    const source = args.source as DataSource;

    if (args.listingId && args.isAvailable === false) {
      await ctx.db.patch(args.listingId, {
        isActive: false,
        lastSeenAt: now,
      });
    } else if (args.listingId) {
      await ctx.db.patch(args.listingId, {
        lastSeenAt: now,
        currentPrice: args.price,
        originalPrice: args.originalPrice,
        availableQuantity: args.availableQuantity,
        isActive: true,
      });
    }

    const existing = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product_source_period", (q) =>
        q
          .eq("productId", args.productId)
          .eq("source", source)
          .eq("periodKey", periodKey),
      )
      .unique();
    if (existing) {
      return { created: false };
    }

    await ctx.db.insert("radarProductSnapshots", {
      productId: args.productId,
      listingId: args.listingId,
      source,
      capturedAt: now,
      periodKey,
      price: args.price,
      originalPrice: args.originalPrice,
      reviewCount: args.reviewCount,
      rating: args.rating,
      soldQuantity: args.soldQuantity,
      availableQuantity: args.availableQuantity,
      searchPosition: args.searchPosition,
      sellerCount: args.sellerCount,
      listingCount: args.listingCount,
      mentionCount: args.mentionCount,
      viewCount: args.viewCount,
      searchInterest: args.searchInterest,
      metadataJson: args.metadataJson,
    });
    return { created: true };
  },
});

export const writeTrendTermSnapshot = internalMutation({
  args: {
    term: v.string(),
    country: v.string(),
    interest: v.optional(v.number()),
    relativeInterest: v.optional(v.number()),
    growth7d: v.optional(v.number()),
    growth30d: v.optional(v.number()),
    breakout: v.optional(v.boolean()),
    regionDataJson: v.optional(v.string()),
    relatedQueriesJson: v.optional(v.string()),
  },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const periodKey = periodKeyFromTs(now);
    const normalized = normalizeAlias(args.term);
    let termDoc = await ctx.db
      .query("radarSearchTerms")
      .withIndex("by_normalized_country", (q) =>
        q.eq("normalizedTerm", normalized).eq("country", args.country),
      )
      .unique();
    if (!termDoc) {
      const id = await ctx.db.insert("radarSearchTerms", {
        term: args.term,
        normalizedTerm: normalized,
        country: args.country,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      termDoc = await ctx.db.get(id);
    }
    if (!termDoc) return { created: false };

    const existing = await ctx.db
      .query("radarSearchTermSnapshots")
      .withIndex("by_term_source_period", (q) =>
        q
          .eq("searchTermId", termDoc!._id)
          .eq("source", "trends_agent")
          .eq("periodKey", periodKey),
      )
      .unique();
    if (existing) return { created: false };

    await ctx.db.insert("radarSearchTermSnapshots", {
      searchTermId: termDoc._id,
      source: "trends_agent",
      capturedAt: now,
      periodKey,
      interest: args.interest,
      relativeInterest: args.relativeInterest,
      growth7d: args.growth7d,
      growth30d: args.growth30d,
      breakout: args.breakout,
      regionDataJson: args.regionDataJson,
      relatedQueriesJson: args.relatedQueriesJson,
    });

    // Propagate interest onto products whose aliases match the term
    const aliases = await ctx.db
      .query("radarProductAliases")
      .withIndex("by_normalized", (q) => q.eq("normalizedAlias", normalized))
      .collect();
    for (const alias of aliases) {
      const snapExists = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", alias.productId)
            .eq("source", "trends_agent")
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!snapExists) {
        await ctx.db.insert("radarProductSnapshots", {
          productId: alias.productId,
          source: "trends_agent",
          capturedAt: now,
          periodKey,
          searchInterest: args.relativeInterest ?? args.interest,
          metadataJson: JSON.stringify({ term: args.term, relative: true }),
        });
      }
    }

    return { created: true };
  },
});

export const calculateAllFeatures = internalMutation({
  args: { asOf: v.optional(v.number()) },
  returns: v.object({ processed: v.number() }),
  handler: async (ctx, args) => {
    const asOf = args.asOf ?? Date.now();
    const products = await ctx.db.query("radarProducts").collect();
    let processed = 0;
    const events = await ctx.db
      .query("radarSeasonalEvents")
      .withIndex("by_country_active", (q) =>
        q.eq("country", "AR").eq("isActive", true),
      )
      .collect();

    for (const product of products) {
      const snaps = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .collect();
      const rows: SnapshotRow[] = snaps.map((s) => ({
        productId: s.productId,
        source: s.source as DataSource,
        capturedAt: s.capturedAt,
        periodKey: s.periodKey,
        price: s.price,
        soldQuantity: s.soldQuantity,
        reviewCount: s.reviewCount,
        sellerCount: s.sellerCount,
        listingCount: s.listingCount,
        mentionCount: s.mentionCount,
        viewCount: s.viewCount,
        searchInterest: s.searchInterest,
      }));
      const biz = await ctx.db
        .query("radarProductBusinessData")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .unique();

      for (const windowDays of [7, 14, 30] as const) {
        const features = computeFeaturesFromSnapshots(rows, windowDays, asOf, {
          expectedSources: expectedSourceCount(),
          expectedRoles: expectedRoleCount(),
        });
        await ctx.db.insert("radarProductFeatures", {
          productId: product._id,
          calculatedAt: asOf,
          windowDays,
          demandGrowth: features.demandGrowth ?? undefined,
          demandVelocity: features.demandVelocity ?? undefined,
          demandAcceleration: features.demandAcceleration ?? undefined,
          reviewsVelocity: features.reviewsVelocity ?? undefined,
          salesVelocity: features.salesVelocity ?? undefined,
          socialVelocity: features.socialVelocity ?? undefined,
          sellerGrowth: features.sellerGrowth ?? undefined,
          listingGrowth: features.listingGrowth ?? undefined,
          competitionRatio: features.competitionRatio ?? undefined,
          priceChange: features.priceChange ?? undefined,
          crossSourceConfirmation:
            features.crossSourceConfirmation ?? undefined,
          seasonalityScore: seasonalityAt(events, asOf, product.country).score,
          estimatedMargin: biz?.estimatedMargin,
          logisticsScore: biz?.logisticsScore,
          riskScore: biz?.regulatoryRisk,
          featuresJson: JSON.stringify({
            ...features,
            attentionDemandGrowth: features.attentionDemandGrowth,
            commerceDemandGrowth: features.commerceDemandGrowth,
            sourcingFitGrowth: features.sourcingFitGrowth,
            confirmingRoles: features.confirmingRoles,
            confirmingSources: features.confirmingSources,
          }),
        });
      }
      processed += 1;
    }
    return { processed };
  },
});

export const calculateAllScores = internalMutation({
  args: { asOf: v.optional(v.number()) },
  returns: v.object({ processed: v.number() }),
  handler: async (ctx, args) => {
    const asOf = args.asOf ?? Date.now();
    const products = await ctx.db.query("radarProducts").collect();
    let processed = 0;
    const events = await ctx.db
      .query("radarSeasonalEvents")
      .withIndex("by_country_active", (q) =>
        q.eq("country", "AR").eq("isActive", true),
      )
      .collect();

    for (const product of products) {
      const snaps = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .collect();
      const rows: SnapshotRow[] = snaps.map((s) => ({
        productId: s.productId,
        source: s.source as DataSource,
        capturedAt: s.capturedAt,
        periodKey: s.periodKey,
        price: s.price,
        soldQuantity: s.soldQuantity,
        reviewCount: s.reviewCount,
        sellerCount: s.sellerCount,
        listingCount: s.listingCount,
        mentionCount: s.mentionCount,
        viewCount: s.viewCount,
        searchInterest: s.searchInterest,
      }));
      const features = computeFeaturesFromSnapshots(rows, 7, asOf, {
        expectedSources: expectedSourceCount(),
        expectedRoles: expectedRoleCount(),
      });
      const biz = await ctx.db
        .query("radarProductBusinessData")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .unique();
      const sat = saturationFromFeatures(features);
      const seasonal = seasonalityAt(events, asOf, product.country).score;
      const listings = await ctx.db
        .query("radarMarketplaceListings")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .collect();
      const activeListings = listings.filter((l) => l.isActive && l.externalUrl);
      const attentionBuzz = snaps
        .filter(
          (s) =>
            s.searchInterest != null &&
            (s.source === "discovery_agent" ||
              s.source === "google_ads" ||
              s.source === "gemini_research" ||
              s.source === "trends_agent" ||
              s.source === "google_trends"),
        )
        .map((s) => s.searchInterest as number)
        .sort((a, b) => b - a)[0];

      const result = computeOpportunityScore({
        demandGrowth: features.demandGrowth,
        demandAcceleration: features.demandAcceleration,
        crossSourceConfirmation: features.crossSourceConfirmation,
        demandSupplyGap:
          features.competitionRatio != null
            ? Math.min(1, features.competitionRatio / 10) -
              (features.listingGrowth ?? 0)
            : null,
        salesOrReviewsVelocity:
          features.salesVelocity ?? features.reviewsVelocity,
        estimatedMargin: biz?.estimatedMargin ?? null,
        logisticsScore: biz?.logisticsScore ?? null,
        saturation: sat,
        seasonality: seasonal,
        regulatoryRisk: biz?.regulatoryRisk ?? null,
        dataQuality: Math.min(1, Math.max(features.historyDays / 30, activeListings.length > 0 ? 0.35 : 0)),
        sourceCount: features.sourceCount,
        expectedSources: features.expectedSources,
        historyDays: features.historyDays,
        confirmingRoles: features.confirmingRoles,
        confirmingSources: features.confirmingSources,
        attentionDemandGrowth: features.attentionDemandGrowth,
        commerceDemandGrowth: features.commerceDemandGrowth,
        listingCount: activeListings.length,
        attentionBuzz: attentionBuzz ?? null,
      });
      await ctx.db.insert("radarProductScores", {
        productId: product._id,
        calculatedAt: asOf,
        score: result.score,
        classification: result.classification,
        confidence: result.confidence,
        explanationJson: result.explanation,
        scoringVersion: result.scoringVersion,
      });
      processed += 1;
    }
    return { processed };
  },
});

export const markInactiveListings = internalMutation({
  args: { staleDays: v.optional(v.number()) },
  returns: v.object({ marked: v.number() }),
  handler: async (ctx, args) => {
    const staleDays = args.staleDays ?? 7;
    const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
    const listings = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
    let marked = 0;
    for (const listing of listings) {
      if (listing.lastSeenAt < cutoff) {
        await ctx.db.patch(listing._id, { isActive: false });
        marked += 1;
      }
    }
    return { marked };
  },
});

/** Discover products from active search terms via Mercado Libre (optional). */
export const runDiscoverProducts = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    let processed = 0;
    let successful = 0;
    let failed = 0;
    const errors: string[] = [];

    try {
      const mlUsable =
        resolveSources().find((s) => s.id === "mercadolibre")?.usable ?? false;
      if (!mlUsable) {
        await ctx.runMutation(internal.radar.jobs.finishJob, {
          jobId: args.jobId,
          status: "COMPLETED",
          processedItems: 0,
          successfulItems: 0,
          failedItems: 0,
          errorSummary:
            "Mercado Libre disabled — skipped DiscoverProducts (not in TREND_RADAR_SOURCES)",
        });
        return null;
      }

      const terms: Array<{
        _id: Id<"radarSearchTerms">;
        term: string;
        country: string;
      }> = await ctx.runQuery(internal.radar.jobs.listActiveSearchTerms, {});
      if (terms.length === 0) {
        throw new Error("No active search terms configured");
      }
      const token = await resolveMercadoLibreAccessToken(ctx);
      const provider = createMercadoLibreProvider({
        accessToken: token,
        maxRequestsPerMinute: Number(
          process.env.TREND_RADAR_MAX_REQUESTS_PER_MINUTE ?? 30,
        ),
        timeoutMs: Number(
          process.env.TREND_RADAR_REQUEST_TIMEOUT_MS ?? 15000,
        ),
        jobId: args.jobId,
      });

      for (const term of terms) {
        processed += 1;
        try {
          const result = await provider.searchProducts?.({
            query: term.term,
            country: term.country,
            limit: 10,
          });
          if (!result) continue;
          for (const item of result.items) {
            await ctx.runMutation(internal.radar.jobs.upsertListingAndSnapshot, {
              source: item.source,
              externalId: item.externalId,
              title: item.title,
              externalUrl: item.externalUrl,
              price: item.price,
              originalPrice: item.originalPrice,
              currency: item.currency,
              sellerId: item.sellerId,
              sellerName: item.sellerName,
              availableQuantity: item.availableQuantity,
              condition: item.condition,
              categoryExternalId: item.categoryExternalId,
              soldQuantity: item.soldQuantity,
              reviewCount: item.reviewCount,
              rating: item.rating,
              searchPosition: item.searchPosition,
              metadataJson: item.metadata
                ? JSON.stringify(item.metadata)
                : undefined,
              country: term.country,
            });
            successful += 1;
          }
          for (const err of result.errors) {
            failed += 1;
            errors.push(err.message);
          }
        } catch (e) {
          failed += 1;
          errors.push(e instanceof Error ? e.message : "discover failed");
          structuredLog({
            jobId: args.jobId,
            source: "mercadolibre",
            errorType: "job_item_error",
            message: e instanceof Error ? e.message : "error",
          });
        }
      }

      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed,
        errorSummary: errors.slice(0, 5).join("; ") || undefined,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed + 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});

export const runCollectMarketplaceSnapshots = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    let processed = 0;
    let successful = 0;
    let failed = 0;

    try {
      const products: Array<{
        _id: Id<"radarProducts">;
        canonicalName: string;
        listings: Array<{
          _id: Id<"radarMarketplaceListings">;
          source: string;
          externalId: string;
          externalUrl?: string;
        }>;
      }> = await ctx.runQuery(internal.radar.jobs.listTrackedProducts, {});
      const token = await resolveMercadoLibreAccessToken(ctx);
      const provider = createMercadoLibreProvider({
        accessToken: token,
        jobId: args.jobId,
      });
      let aeProvider: ReturnType<typeof createAliExpressProviderFromEnv> | null =
        null;
      try {
        aeProvider = createAliExpressProviderFromEnv(args.jobId);
      } catch {
        // AliExpress optional for collect if not configured
        aeProvider = null;
      }

      for (const product of products) {
        processed += 1;
        try {
          const result = await provider.collectProductMetrics?.({
            productId: product._id,
            canonicalName: product.canonicalName,
            listings: product.listings.map((l) => ({
              listingId: l._id,
              source: l.source as DataSource,
              externalId: l.externalId,
              externalUrl: l.externalUrl,
            })),
          });
          if (!result) continue;
          for (const obs of result.items) {
            await ctx.runMutation(internal.radar.jobs.writeObservationSnapshot, {
              productId: product._id,
              listingId: obs.listingId as Id<"radarMarketplaceListings"> | undefined,
              source: obs.source,
              price: obs.price,
              originalPrice: obs.originalPrice,
              reviewCount: obs.reviewCount,
              rating: obs.rating,
              soldQuantity: obs.soldQuantity,
              availableQuantity: obs.availableQuantity,
              searchPosition: obs.searchPosition,
              sellerCount: obs.sellerCount,
              listingCount: obs.listingCount,
              mentionCount: obs.mentionCount,
              viewCount: obs.viewCount,
              searchInterest: obs.searchInterest,
              isAvailable: obs.isAvailable,
              metadataJson: obs.metadata
                ? JSON.stringify(obs.metadata)
                : undefined,
            });
            successful += 1;
          }
          failed += result.errors.length;

          if (aeProvider) {
            const aeListings = product.listings.filter(
              (l) => l.source === "aliexpress",
            );
            if (aeListings.length > 0) {
              const aeResult = await aeProvider.collectProductMetrics?.({
                productId: product._id,
                canonicalName: product.canonicalName,
                listings: aeListings.map((l) => ({
                  listingId: l._id,
                  source: "aliexpress" as DataSource,
                  externalId: l.externalId,
                  externalUrl: l.externalUrl,
                })),
              });
              for (const obs of aeResult?.items ?? []) {
                await ctx.runMutation(
                  internal.radar.jobs.writeObservationSnapshot,
                  {
                    productId: product._id,
                    listingId: obs.listingId as
                      | Id<"radarMarketplaceListings">
                      | undefined,
                    source: obs.source,
                    price: obs.price,
                    originalPrice: obs.originalPrice,
                    soldQuantity: obs.soldQuantity,
                    isAvailable: obs.isAvailable,
                    metadataJson: obs.metadata
                      ? JSON.stringify(obs.metadata)
                      : undefined,
                  },
                );
                successful += 1;
              }
              failed += aeResult?.errors.length ?? 0;
            }
          }
        } catch (e) {
          failed += 1;
          structuredLog({
            jobId: args.jobId,
            productId: product._id,
            errorType: "collect_error",
            message: e instanceof Error ? e.message : "error",
          });
        }
      }

      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed + 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});

export const runCalculateFeatures = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    try {
      const result = await ctx.runMutation(
        internal.radar.jobs.calculateAllFeatures,
        {},
      );
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "COMPLETED",
        processedItems: result.processed,
        successfulItems: result.processed,
        failedItems: 0,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: 0,
        successfulItems: 0,
        failedItems: 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});

export const runCalculateScores = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    try {
      const result = await ctx.runMutation(
        internal.radar.jobs.calculateAllScores,
        {},
      );
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "COMPLETED",
        processedItems: result.processed,
        successfulItems: result.processed,
        failedItems: 0,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: 0,
        successfulItems: 0,
        failedItems: 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});

export const runMarkInactive = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    try {
      const result = await ctx.runMutation(
        internal.radar.jobs.markInactiveListings,
        {},
      );
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "COMPLETED",
        processedItems: result.marked,
        successfulItems: result.marked,
        failedItems: 0,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: 0,
        successfulItems: 0,
        failedItems: 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});

export const triggerJob = mutation({
  args: {
    type: jobTypeValidator,
  },
  returns: v.id("radarJobs"),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    // Admin gate for MVP: authenticated onboarded users (plan-ready for stricter RBAC).
    if (!user.onboardingComplete && user.plan === "free") {
      // Allow anyway for demo; production should check admin role.
    }

    const jobId = await ctx.db.insert("radarJobs", {
      type: args.type,
      status: "PENDING",
      processedItems: 0,
      successfulItems: 0,
      failedItems: 0,
      createdAt: Date.now(),
      createdBy: user._id,
    });

    switch (args.type) {
      case "DiscoverProducts":
        await ctx.scheduler.runAfter(
          0,
          internal.radar.discovery.runEnrichFromMarketplaces,
          { jobId },
        );
        break;
      case "EnrichFromMarketplaces":
        await ctx.scheduler.runAfter(
          0,
          internal.radar.discovery.runEnrichFromMarketplaces,
          { jobId },
        );
        break;
      case "EnrichFromWholesale":
        await ctx.scheduler.runAfter(
          0,
          internal.radar.discovery.runEnrichFromWholesale,
          { jobId },
        );
        break;
      case "CollectMarketplaceSnapshots":
        await ctx.scheduler.runAfter(
          0,
          internal.radar.jobs.runCollectMarketplaceSnapshots,
          { jobId },
        );
        break;
      case "CollectMetaAds":
        await ctx.db.patch(jobId, {
          status: "COMPLETED",
          finishedAt: Date.now(),
          processedItems: 0,
          successfulItems: 0,
          metadataJson: JSON.stringify({
            note: "Scrape runs in external worker; job records enqueue intent",
          }),
        });
        break;
      case "CalculateFeatures":
        await ctx.scheduler.runAfter(
          0,
          internal.radar.jobs.runCalculateFeatures,
          { jobId },
        );
        break;
      case "CalculateScores":
        await ctx.scheduler.runAfter(0, internal.radar.jobs.runCalculateScores, {
          jobId,
        });
        break;
      case "MarkInactiveListings":
        await ctx.scheduler.runAfter(0, internal.radar.jobs.runMarkInactive, {
          jobId,
        });
        break;
      case "SeedDemo":
        await ctx.scheduler.runAfter(0, internal.radar.jobs.runSeedDemoJob, {
          jobId,
        });
        break;
      default: {
        const _exhaustive: never = args.type;
        throw new Error(`Unknown job type: ${_exhaustive}`);
      }
    }

    return jobId;
  },
});

export const runSeedDemoJob = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    try {
      const result = await ctx.runMutation(internal.radar.seed.seedDemoData, {
        force: false,
      });
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "COMPLETED",
        processedItems: result.products,
        successfulItems: result.products,
        failedItems: 0,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: 0,
        successfulItems: 0,
        failedItems: 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});
