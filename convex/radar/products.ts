import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireCurrentUser } from "../lib/auth";
import {
  classificationValidator,
  dataSourceValidator,
  explanationValidator,
  productStatusValidator,
} from "./validators";
import { normalizeAlias } from "./normalize";
import { periodKeyFromTs } from "./metrics";
import {
  calculateLogisticsScore,
  calculateMargin,
} from "./logistics";

const rankingRowValidator = v.object({
  productId: v.id("radarProducts"),
  canonicalName: v.string(),
  slug: v.string(),
  categoryId: v.optional(v.id("categories")),
  categoryName: v.optional(v.string()),
  status: productStatusValidator,
  score: v.number(),
  confidence: v.number(),
  classification: classificationValidator,
  growth7d: v.optional(v.number()),
  growth30d: v.optional(v.number()),
  acceleration: v.optional(v.number()),
  salesVelocity: v.optional(v.number()),
  reviewsVelocity: v.optional(v.number()),
  sourceCount: v.optional(v.number()),
  sellerCount: v.optional(v.number()),
  estimatedMargin: v.optional(v.number()),
  calculatedAt: v.number(),
  isDemo: v.optional(v.boolean()),
  confirmingSources: v.optional(v.array(v.string())),
  confirmingRoles: v.optional(v.array(v.string())),
});

export const listRankings = query({
  args: {
    categoryId: v.optional(v.id("categories")),
    classification: v.optional(classificationValidator),
    minScore: v.optional(v.number()),
    minConfidence: v.optional(v.number()),
    source: v.optional(dataSourceValidator),
    minMargin: v.optional(v.number()),
    minGrowth: v.optional(v.number()),
    includeInsufficient: v.optional(v.boolean()),
    pendingReviewOnly: v.optional(v.boolean()),
    sortBy: v.optional(
      v.union(
        v.literal("score"),
        v.literal("acceleration"),
        v.literal("growth"),
        v.literal("margin"),
        v.literal("competition"),
        v.literal("recent"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  returns: v.array(rankingRowValidator),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const limit = args.limit ?? 50;

    const products = await ctx.db.query("radarProducts").collect();
    const rows = [];

    for (const product of products) {
      if (
        args.pendingReviewOnly &&
        product.status !== "pending_review"
      ) {
        continue;
      }
      if (args.categoryId && product.categoryId !== args.categoryId) {
        continue;
      }

      const latestScore = await ctx.db
        .query("radarProductScores")
        .withIndex("by_product_and_calculated", (q) =>
          q.eq("productId", product._id),
        )
        .order("desc")
        .first();
      if (!latestScore) continue;

      if (
        args.classification &&
        latestScore.classification !== args.classification
      ) {
        continue;
      }
      if (
        !args.includeInsufficient &&
        latestScore.classification === "INSUFFICIENT_DATA" &&
        args.classification !== "INSUFFICIENT_DATA"
      ) {
        // still include unless filtered out by min score etc.
      }
      if (args.minScore != null && latestScore.score < args.minScore) {
        continue;
      }
      if (
        args.minConfidence != null &&
        latestScore.confidence < args.minConfidence
      ) {
        continue;
      }

      if (args.source) {
        const snap = await ctx.db
          .query("radarProductSnapshots")
          .withIndex("by_product", (q) => q.eq("productId", product._id))
          .collect();
        if (!snap.some((s) => s.source === args.source)) continue;
      }

      const feat7 = await ctx.db
        .query("radarProductFeatures")
        .withIndex("by_product_window", (q) =>
          q.eq("productId", product._id).eq("windowDays", 7),
        )
        .order("desc")
        .first();
      const feat30 = await ctx.db
        .query("radarProductFeatures")
        .withIndex("by_product_window", (q) =>
          q.eq("productId", product._id).eq("windowDays", 30),
        )
        .order("desc")
        .first();

      if (
        args.minGrowth != null &&
        (feat7?.demandGrowth == null || feat7.demandGrowth < args.minGrowth)
      ) {
        continue;
      }

      const biz = await ctx.db
        .query("radarProductBusinessData")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .unique();
      if (
        args.minMargin != null &&
        (biz?.estimatedMargin == null ||
          biz.estimatedMargin < args.minMargin)
      ) {
        continue;
      }

      let categoryName: string | undefined;
      if (product.categoryId) {
        const cat = await ctx.db.get(product.categoryId);
        categoryName = cat?.name;
      }

      const latestMlSnap = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_and_captured", (q) =>
          q.eq("productId", product._id),
        )
        .order("desc")
        .first();

      rows.push({
        productId: product._id,
        canonicalName: product.canonicalName,
        slug: product.slug,
        categoryId: product.categoryId,
        categoryName,
        status: product.status,
        score: latestScore.score,
        confidence: latestScore.confidence,
        classification: latestScore.classification,
        growth7d: feat7?.demandGrowth,
        growth30d: feat30?.demandGrowth,
        acceleration: feat7?.demandAcceleration,
        salesVelocity: feat7?.salesVelocity,
        reviewsVelocity: feat7?.reviewsVelocity,
        sourceCount: latestScore.explanationJson.dataQuality.availableSources,
        sellerCount: latestMlSnap?.sellerCount,
        estimatedMargin: biz?.estimatedMargin ?? feat7?.estimatedMargin,
        calculatedAt: latestScore.calculatedAt,
        isDemo: product.isDemo,
        confirmingSources:
          latestScore.explanationJson.confirmingSources ?? [],
        confirmingRoles: latestScore.explanationJson.confirmingRoles ?? [],
      });
    }

    const sortBy = args.sortBy ?? "score";
    rows.sort((a, b) => {
      switch (sortBy) {
        case "score":
          return b.score - a.score;
        case "acceleration":
          return (b.acceleration ?? -999) - (a.acceleration ?? -999);
        case "growth":
          return (b.growth7d ?? -999) - (a.growth7d ?? -999);
        case "margin":
          return (b.estimatedMargin ?? -999) - (a.estimatedMargin ?? -999);
        case "competition":
          return (a.sellerCount ?? 999) - (b.sellerCount ?? 999);
        case "recent":
          return b.calculatedAt - a.calculatedAt;
        default: {
          const _exhaustive: never = sortBy;
          return _exhaustive;
        }
      }
    });

    return rows.slice(0, limit);
  },
});

export const listProducts = query({
  args: {
    status: v.optional(productStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("radarProducts"),
      canonicalName: v.string(),
      slug: v.string(),
      status: productStatusValidator,
      categoryId: v.optional(v.id("categories")),
      brand: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const limit = args.limit ?? 100;
    let products: Doc<"radarProducts">[];
    if (args.status) {
      products = await ctx.db
        .query("radarProducts")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .take(limit);
    } else {
      products = await ctx.db.query("radarProducts").take(limit);
    }
    return products.map((p) => ({
      _id: p._id,
      canonicalName: p.canonicalName,
      slug: p.slug,
      status: p.status,
      categoryId: p.categoryId,
      brand: p.brand,
      updatedAt: p.updatedAt,
    }));
  },
});

export const getProduct = query({
  args: { productId: v.id("radarProducts") },
  returns: v.union(
    v.null(),
    v.object({
      product: v.object({
        _id: v.id("radarProducts"),
        canonicalName: v.string(),
        slug: v.string(),
        description: v.optional(v.string()),
        brand: v.optional(v.string()),
        model: v.optional(v.string()),
        categoryId: v.optional(v.id("categories")),
        categoryName: v.optional(v.string()),
        status: productStatusValidator,
        country: v.string(),
        isDemo: v.optional(v.boolean()),
        updatedAt: v.number(),
      }),
      score: v.union(
        v.null(),
        v.object({
          score: v.number(),
          confidence: v.number(),
          classification: classificationValidator,
          calculatedAt: v.number(),
          explanation: explanationValidator,
          scoringVersion: v.string(),
        }),
      ),
      features7: v.union(
        v.null(),
        v.object({
          demandGrowth: v.optional(v.number()),
          demandVelocity: v.optional(v.number()),
          demandAcceleration: v.optional(v.number()),
          reviewsVelocity: v.optional(v.number()),
          salesVelocity: v.optional(v.number()),
          socialVelocity: v.optional(v.number()),
          sellerGrowth: v.optional(v.number()),
          listingGrowth: v.optional(v.number()),
          crossSourceConfirmation: v.optional(v.number()),
          estimatedMargin: v.optional(v.number()),
          logisticsScore: v.optional(v.number()),
          windowDays: v.number(),
          calculatedAt: v.number(),
        }),
      ),
      features30: v.union(
        v.null(),
        v.object({
          demandGrowth: v.optional(v.number()),
          demandVelocity: v.optional(v.number()),
          demandAcceleration: v.optional(v.number()),
          reviewsVelocity: v.optional(v.number()),
          salesVelocity: v.optional(v.number()),
          socialVelocity: v.optional(v.number()),
          sellerGrowth: v.optional(v.number()),
          listingGrowth: v.optional(v.number()),
          crossSourceConfirmation: v.optional(v.number()),
          estimatedMargin: v.optional(v.number()),
          logisticsScore: v.optional(v.number()),
          windowDays: v.number(),
          calculatedAt: v.number(),
        }),
      ),
      business: v.union(
        v.null(),
        v.object({
          purchaseCost: v.optional(v.number()),
          shippingCost: v.optional(v.number()),
          taxCost: v.optional(v.number()),
          platformFee: v.optional(v.number()),
          packagingCost: v.optional(v.number()),
          estimatedSalePrice: v.optional(v.number()),
          weightKg: v.optional(v.number()),
          widthCm: v.optional(v.number()),
          heightCm: v.optional(v.number()),
          depthCm: v.optional(v.number()),
          regulatoryRisk: v.optional(v.number()),
          fragility: v.optional(v.number()),
          storageDifficulty: v.optional(v.number()),
          isHazardous: v.optional(v.boolean()),
          estimatedProfit: v.optional(v.number()),
          estimatedMargin: v.optional(v.number()),
          logisticsScore: v.optional(v.number()),
        }),
      ),
      listings: v.array(
        v.object({
          _id: v.id("radarMarketplaceListings"),
          source: dataSourceValidator,
          externalId: v.string(),
          externalUrl: v.optional(v.string()),
          title: v.string(),
          sellerName: v.optional(v.string()),
          currentPrice: v.optional(v.number()),
          currency: v.optional(v.string()),
          firstSeenAt: v.number(),
          lastSeenAt: v.number(),
          isActive: v.boolean(),
        }),
      ),
      aliases: v.array(
        v.object({
          _id: v.id("radarProductAliases"),
          alias: v.string(),
          source: dataSourceValidator,
        }),
      ),
      primarySourceUrl: v.union(v.string(), v.null()),
      imageHint: v.union(v.string(), v.null()),
      history: v.object({
        searchInterest: v.array(
          v.object({ at: v.number(), value: v.optional(v.number()) }),
        ),
        soldQuantity: v.array(
          v.object({ at: v.number(), value: v.optional(v.number()) }),
        ),
        reviewCount: v.array(
          v.object({ at: v.number(), value: v.optional(v.number()) }),
        ),
        price: v.array(
          v.object({ at: v.number(), value: v.optional(v.number()) }),
        ),
        sellerCount: v.array(
          v.object({ at: v.number(), value: v.optional(v.number()) }),
        ),
        listingCount: v.array(
          v.object({ at: v.number(), value: v.optional(v.number()) }),
        ),
        scores: v.array(
          v.object({
            at: v.number(),
            score: v.number(),
            confidence: v.number(),
          }),
        ),
        bySource: v.array(
          v.object({
            source: dataSourceValidator,
            searchInterest: v.array(
              v.object({ at: v.number(), value: v.optional(v.number()) }),
            ),
            soldQuantity: v.array(
              v.object({ at: v.number(), value: v.optional(v.number()) }),
            ),
            reviewCount: v.array(
              v.object({ at: v.number(), value: v.optional(v.number()) }),
            ),
            price: v.array(
              v.object({ at: v.number(), value: v.optional(v.number()) }),
            ),
            mentionCount: v.array(
              v.object({ at: v.number(), value: v.optional(v.number()) }),
            ),
            viewCount: v.array(
              v.object({ at: v.number(), value: v.optional(v.number()) }),
            ),
          }),
        ),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) return null;

    let categoryName: string | undefined;
    if (product.categoryId) {
      const cat = await ctx.db.get(product.categoryId);
      categoryName = cat?.name;
    }

    const latestScore = await ctx.db
      .query("radarProductScores")
      .withIndex("by_product_and_calculated", (q) =>
        q.eq("productId", product._id),
      )
      .order("desc")
      .first();

    const features7 = await ctx.db
      .query("radarProductFeatures")
      .withIndex("by_product_window", (q) =>
        q.eq("productId", product._id).eq("windowDays", 7),
      )
      .order("desc")
      .first();
    const features30 = await ctx.db
      .query("radarProductFeatures")
      .withIndex("by_product_window", (q) =>
        q.eq("productId", product._id).eq("windowDays", 30),
      )
      .order("desc")
      .first();

    const business = await ctx.db
      .query("radarProductBusinessData")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .unique();

    const listings = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .collect();

    const aliases = await ctx.db
      .query("radarProductAliases")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .collect();

    const snaps = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product_and_captured", (q) =>
        q.eq("productId", product._id),
      )
      .order("asc")
      .collect();

    const scores = await ctx.db
      .query("radarProductScores")
      .withIndex("by_product_and_calculated", (q) =>
        q.eq("productId", product._id),
      )
      .order("asc")
      .collect();

    const series = (
      field:
        | "searchInterest"
        | "soldQuantity"
        | "reviewCount"
        | "price"
        | "sellerCount"
        | "listingCount"
        | "mentionCount"
        | "viewCount",
    ) =>
      snaps
        .filter((s) => s[field] != null)
        .map((s) => ({ at: s.capturedAt, value: s[field] }));

    const sourcesPresent = [...new Set(snaps.map((s) => s.source))];
    const bySource = sourcesPresent.map((source) => {
      const sourceSnaps = snaps.filter((s) => s.source === source);
      const fieldSeries = (
        field:
          | "searchInterest"
          | "soldQuantity"
          | "reviewCount"
          | "price"
          | "mentionCount"
          | "viewCount",
      ) =>
        sourceSnaps
          .filter((s) => s[field] != null)
          .map((s) => ({ at: s.capturedAt, value: s[field] }));
      return {
        source,
        searchInterest: fieldSeries("searchInterest"),
        soldQuantity: fieldSeries("soldQuantity"),
        reviewCount: fieldSeries("reviewCount"),
        price: fieldSeries("price"),
        mentionCount: fieldSeries("mentionCount"),
        viewCount: fieldSeries("viewCount"),
      };
    });

    return {
      product: {
        _id: product._id,
        canonicalName: product.canonicalName,
        slug: product.slug,
        description: product.description,
        brand: product.brand,
        model: product.model,
        categoryId: product.categoryId,
        categoryName,
        status: product.status,
        country: product.country,
        isDemo: product.isDemo,
        updatedAt: product.updatedAt,
      },
      score: latestScore
        ? {
            score: latestScore.score,
            confidence: latestScore.confidence,
            classification: latestScore.classification,
            calculatedAt: latestScore.calculatedAt,
            explanation: latestScore.explanationJson,
            scoringVersion: latestScore.scoringVersion,
          }
        : null,
      features7: features7
        ? {
            demandGrowth: features7.demandGrowth,
            demandVelocity: features7.demandVelocity,
            demandAcceleration: features7.demandAcceleration,
            reviewsVelocity: features7.reviewsVelocity,
            salesVelocity: features7.salesVelocity,
            socialVelocity: features7.socialVelocity,
            sellerGrowth: features7.sellerGrowth,
            listingGrowth: features7.listingGrowth,
            crossSourceConfirmation: features7.crossSourceConfirmation,
            estimatedMargin: features7.estimatedMargin,
            logisticsScore: features7.logisticsScore,
            windowDays: features7.windowDays,
            calculatedAt: features7.calculatedAt,
          }
        : null,
      features30: features30
        ? {
            demandGrowth: features30.demandGrowth,
            demandVelocity: features30.demandVelocity,
            demandAcceleration: features30.demandAcceleration,
            reviewsVelocity: features30.reviewsVelocity,
            salesVelocity: features30.salesVelocity,
            socialVelocity: features30.socialVelocity,
            sellerGrowth: features30.sellerGrowth,
            listingGrowth: features30.listingGrowth,
            crossSourceConfirmation: features30.crossSourceConfirmation,
            estimatedMargin: features30.estimatedMargin,
            logisticsScore: features30.logisticsScore,
            windowDays: features30.windowDays,
            calculatedAt: features30.calculatedAt,
          }
        : null,
      business: business
        ? {
            purchaseCost: business.purchaseCost,
            shippingCost: business.shippingCost,
            taxCost: business.taxCost,
            platformFee: business.platformFee,
            packagingCost: business.packagingCost,
            estimatedSalePrice: business.estimatedSalePrice,
            weightKg: business.weightKg,
            widthCm: business.widthCm,
            heightCm: business.heightCm,
            depthCm: business.depthCm,
            regulatoryRisk: business.regulatoryRisk,
            fragility: business.fragility,
            storageDifficulty: business.storageDifficulty,
            isHazardous: business.isHazardous,
            estimatedProfit: business.estimatedProfit,
            estimatedMargin: business.estimatedMargin,
            logisticsScore: business.logisticsScore,
          }
        : null,
      listings: listings.map((l) => ({
        _id: l._id,
        source: l.source,
        externalId: l.externalId,
        externalUrl: l.externalUrl,
        title: l.title,
        sellerName: l.sellerName,
        currentPrice: l.currentPrice,
        currency: l.currency,
        firstSeenAt: l.firstSeenAt,
        lastSeenAt: l.lastSeenAt,
        isActive: l.isActive,
      })),
      aliases: aliases.map((a) => ({
        _id: a._id,
        alias: a.alias,
        source: a.source,
      })),
      primarySourceUrl:
        listings.find((l) => l.isActive && l.externalUrl)?.externalUrl ?? null,
      imageHint: (() => {
        for (const l of listings) {
          if (!l.isActive || !l.metadataJson) continue;
          try {
            const meta = JSON.parse(l.metadataJson) as { imageUrl?: unknown };
            if (
              typeof meta.imageUrl === "string" &&
              (meta.imageUrl.startsWith("http://") ||
                meta.imageUrl.startsWith("https://"))
            ) {
              return meta.imageUrl;
            }
          } catch {
            // ignore
          }
        }
        return null;
      })(),
      history: {
        searchInterest: series("searchInterest"),
        soldQuantity: series("soldQuantity"),
        reviewCount: series("reviewCount"),
        price: series("price"),
        sellerCount: series("sellerCount"),
        listingCount: series("listingCount"),
        scores: scores.map((s) => ({
          at: s.calculatedAt,
          score: s.score,
          confidence: s.confidence,
        })),
        bySource,
      },
    };
  },
});

export const trackProduct = mutation({
  args: { productId: v.id("radarProducts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");
    await ctx.db.patch(args.productId, {
      status: "tracked",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const untrackProduct = mutation({
  args: { productId: v.id("radarProducts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");
    await ctx.db.patch(args.productId, {
      status: "archived",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const addManualSignals = mutation({
  args: {
    productId: v.id("radarProducts"),
    source: v.optional(dataSourceValidator),
    mentionCount: v.optional(v.number()),
    viewCount: v.optional(v.number()),
    creatorCount: v.optional(v.number()),
    engagementCount: v.optional(v.number()),
    purchaseIntentCount: v.optional(v.number()),
    capturedAt: v.optional(v.number()),
    metadataJson: v.optional(v.string()),
  },
  returns: v.id("radarSocialSignals"),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const capturedAt = args.capturedAt ?? Date.now();
    const periodKey = periodKeyFromTs(capturedAt);
    const source = args.source ?? "manual_social";

    const existing = await ctx.db
      .query("radarSocialSignals")
      .withIndex("by_product_source_period", (q) =>
        q
          .eq("productId", args.productId)
          .eq("source", source)
          .eq("periodKey", periodKey),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        mentionCount: args.mentionCount,
        viewCount: args.viewCount,
        creatorCount: args.creatorCount,
        engagementCount: args.engagementCount,
        purchaseIntentCount: args.purchaseIntentCount,
        metadataJson: args.metadataJson,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("radarSocialSignals", {
      productId: args.productId,
      source,
      capturedAt,
      periodKey,
      mentionCount: args.mentionCount,
      viewCount: args.viewCount,
      creatorCount: args.creatorCount,
      engagementCount: args.engagementCount,
      purchaseIntentCount: args.purchaseIntentCount,
      metadataJson: args.metadataJson,
    });

    // Mirror into product snapshots for feature calc
    const snapExists = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product_source_period", (q) =>
        q
          .eq("productId", args.productId)
          .eq("source", source)
          .eq("periodKey", periodKey),
      )
      .unique();
    if (!snapExists) {
      await ctx.db.insert("radarProductSnapshots", {
        productId: args.productId,
        source,
        capturedAt,
        periodKey,
        mentionCount: args.mentionCount,
        viewCount: args.viewCount,
        metadataJson: args.metadataJson,
      });
    }

    return id;
  },
});

export const updateBusinessData = mutation({
  args: {
    productId: v.id("radarProducts"),
    purchaseCost: v.optional(v.number()),
    shippingCost: v.optional(v.number()),
    taxCost: v.optional(v.number()),
    platformFee: v.optional(v.number()),
    packagingCost: v.optional(v.number()),
    estimatedSalePrice: v.optional(v.number()),
    weightKg: v.optional(v.number()),
    widthCm: v.optional(v.number()),
    heightCm: v.optional(v.number()),
    depthCm: v.optional(v.number()),
    regulatoryRisk: v.optional(v.number()),
    fragility: v.optional(v.number()),
    storageDifficulty: v.optional(v.number()),
    isHazardous: v.optional(v.boolean()),
  },
  returns: v.id("radarProductBusinessData"),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const existing = await ctx.db
      .query("radarProductBusinessData")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .unique();

    const merged = {
      purchaseCost: args.purchaseCost ?? existing?.purchaseCost,
      shippingCost: args.shippingCost ?? existing?.shippingCost,
      taxCost: args.taxCost ?? existing?.taxCost,
      platformFee: args.platformFee ?? existing?.platformFee,
      packagingCost: args.packagingCost ?? existing?.packagingCost,
      estimatedSalePrice:
        args.estimatedSalePrice ?? existing?.estimatedSalePrice,
      weightKg: args.weightKg ?? existing?.weightKg,
      widthCm: args.widthCm ?? existing?.widthCm,
      heightCm: args.heightCm ?? existing?.heightCm,
      depthCm: args.depthCm ?? existing?.depthCm,
      regulatoryRisk: args.regulatoryRisk ?? existing?.regulatoryRisk,
      fragility: args.fragility ?? existing?.fragility,
      storageDifficulty:
        args.storageDifficulty ?? existing?.storageDifficulty,
      isHazardous: args.isHazardous ?? existing?.isHazardous,
    };

    const margin = calculateMargin(merged);
    const logistics = calculateLogisticsScore(merged);
    const payload = {
      productId: args.productId,
      ...merged,
      estimatedProfit: margin.estimatedProfit ?? undefined,
      estimatedMargin: margin.estimatedMargin ?? undefined,
      logisticsScore: logistics,
      updatedAt: Date.now(),
      updatedBy: user._id,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("radarProductBusinessData", payload);
  },
});

/**
 * Persist Gemini research buy/sell estimates into business data (agent path).
 * When buy/sell currencies differ, still stores both prices but margin may be null
 * until the user reconciles FX.
 */
export const upsertResearchEconomics = internalMutation({
  args: {
    productId: v.id("radarProducts"),
    purchaseCost: v.number(),
    /** Optional until Mercado Libre validates sell. */
    estimatedSalePrice: v.optional(v.number()),
    shippingCost: v.optional(v.number()),
    buyCurrency: v.optional(v.string()),
    sellCurrency: v.optional(v.string()),
    economicsNote: v.optional(v.string()),
  },
  returns: v.id("radarProductBusinessData"),
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const existing = await ctx.db
      .query("radarProductBusinessData")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .unique();

    const sellPrice =
      args.estimatedSalePrice != null && args.estimatedSalePrice > 0
        ? args.estimatedSalePrice
        : existing?.estimatedSalePrice;

    const sameCurrency =
      sellPrice != null &&
      (!args.buyCurrency ||
        !args.sellCurrency ||
        args.buyCurrency === args.sellCurrency);

    const merged = {
      purchaseCost: args.purchaseCost,
      shippingCost: args.shippingCost ?? existing?.shippingCost,
      taxCost: existing?.taxCost,
      platformFee: existing?.platformFee,
      packagingCost: existing?.packagingCost,
      estimatedSalePrice: sellPrice,
      weightKg: existing?.weightKg,
      widthCm: existing?.widthCm,
      heightCm: existing?.heightCm,
      depthCm: existing?.depthCm,
      regulatoryRisk: existing?.regulatoryRisk,
      fragility: existing?.fragility,
      storageDifficulty: existing?.storageDifficulty,
      isHazardous: existing?.isHazardous,
    };

    const margin = sameCurrency
      ? calculateMargin(merged)
      : { estimatedProfit: null, estimatedMargin: null };
    const logistics = calculateLogisticsScore(merged);

    // Currencies / notes are research metadata; not schema columns yet.
    void args.buyCurrency;
    void args.sellCurrency;
    void args.economicsNote;

    const payload = {
      productId: args.productId,
      ...merged,
      estimatedProfit: margin.estimatedProfit ?? undefined,
      estimatedMargin: margin.estimatedMargin ?? undefined,
      logisticsScore: logistics,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("radarProductBusinessData", payload);
  },
});

/** Evidence bundle for post-ML Gemini validation. */
export const getValidationEvidence = internalQuery({
  args: { productId: v.id("radarProducts") },
  returns: v.union(
    v.null(),
    v.object({
      purchaseCost: v.union(v.number(), v.null()),
      shippingCost: v.union(v.number(), v.null()),
      buyCurrency: v.union(v.string(), v.null()),
      buyUrl: v.union(v.string(), v.null()),
      mlSellPrice: v.union(v.number(), v.null()),
      mlSoldQuantity: v.union(v.number(), v.null()),
      mlUrl: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) return null;

    const biz = await ctx.db
      .query("radarProductBusinessData")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .unique();

    const listings = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();

    const mlListing = listings.find(
      (l) =>
        l.isActive &&
        l.source === "mercadolibre" &&
        l.externalUrl &&
        l.currentPrice != null &&
        l.currentPrice > 0,
    );

    const buyListing = listings.find(
      (l) =>
        l.isActive &&
        l.externalUrl &&
        l.source !== "mercadolibre" &&
        (l.source === "made_in_china" ||
          l.source === "alibaba" ||
          l.source === "aliexpress" ||
          l.source === "wholesale" ||
          l.source === "discovery_agent" ||
          l.source === "google_ads" ||
          l.source === "gemini_research" ||
          l.source === "sourcing_agent"),
    );

    let mlSoldQuantity: number | null = null;
    if (mlListing) {
      const snaps = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_and_captured", (q) =>
          q.eq("productId", args.productId),
        )
        .order("desc")
        .take(20);
      const mlSnap = snaps.find(
        (s) =>
          s.source === "mercadolibre" &&
          (s.listingId === mlListing._id || s.soldQuantity != null),
      );
      mlSoldQuantity = mlSnap?.soldQuantity ?? null;
    }

    const chinaBuy =
      buyListing?.source === "made_in_china" ||
      buyListing?.source === "alibaba" ||
      buyListing?.source === "aliexpress";

    return {
      purchaseCost: biz?.purchaseCost ?? null,
      shippingCost: biz?.shippingCost ?? null,
      buyCurrency: chinaBuy ? "USD" : null,
      buyUrl: buyListing?.externalUrl ?? null,
      mlSellPrice: mlListing?.currentPrice ?? null,
      mlSoldQuantity,
      mlUrl: mlListing?.externalUrl ?? null,
    };
  },
});

/**
 * Apply Mercado Libre sell price (authoritative) and recompute margin vs purchase cost.
 */
export const applyMlSaleValidation = internalMutation({
  args: {
    productId: v.id("radarProducts"),
    estimatedSalePrice: v.number(),
    soldQuantity: v.optional(v.number()),
    currency: v.optional(v.string()),
    externalUrl: v.optional(v.string()),
  },
  returns: v.id("radarProductBusinessData"),
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const existing = await ctx.db
      .query("radarProductBusinessData")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .unique();

    const merged = {
      purchaseCost: existing?.purchaseCost,
      shippingCost: existing?.shippingCost,
      taxCost: existing?.taxCost,
      platformFee: existing?.platformFee,
      packagingCost: existing?.packagingCost,
      estimatedSalePrice: args.estimatedSalePrice,
      weightKg: existing?.weightKg,
      widthCm: existing?.widthCm,
      heightCm: existing?.heightCm,
      depthCm: existing?.depthCm,
      regulatoryRisk: existing?.regulatoryRisk,
      fragility: existing?.fragility,
      storageDifficulty: existing?.storageDifficulty,
      isHazardous: existing?.isHazardous,
    };

    const margin = calculateMargin(merged);
    const logistics = calculateLogisticsScore(merged);
    const payload = {
      productId: args.productId,
      ...merged,
      estimatedProfit: margin.estimatedProfit ?? undefined,
      estimatedMargin: margin.estimatedMargin ?? undefined,
      logisticsScore: logistics,
      updatedAt: Date.now(),
    };

    // soldQuantity / currency / url live on marketplace listings; business holds economics.
    void args.soldQuantity;
    void args.currency;
    void args.externalUrl;

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("radarProductBusinessData", payload);
  },
});

export const setProductStatus = internalMutation({
  args: {
    productId: v.id("radarProducts"),
    status: productStatusValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) return null;
    await ctx.db.patch(args.productId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const addAlias = mutation({
  args: {
    productId: v.id("radarProducts"),
    alias: v.string(),
  },
  returns: v.id("radarProductAliases"),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");
    const normalizedAlias = normalizeAlias(args.alias);
    if (!normalizedAlias) throw new Error("Alias vacío tras normalización");

    const existing = await ctx.db
      .query("radarProductAliases")
      .withIndex("by_product_and_normalized", (q) =>
        q
          .eq("productId", args.productId)
          .eq("normalizedAlias", normalizedAlias),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("radarProductAliases", {
      productId: args.productId,
      alias: args.alias,
      normalizedAlias,
      source: "manual_social",
      createdAt: Date.now(),
    });
  },
});

export const updateCanonicalName = mutation({
  args: {
    productId: v.id("radarProducts"),
    canonicalName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");
    if (!args.canonicalName.trim()) throw new Error("Nombre requerido");
    await ctx.db.patch(args.productId, {
      canonicalName: args.canonicalName.trim(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const mergeProducts = mutation({
  args: {
    keepProductId: v.id("radarProducts"),
    mergeProductId: v.id("radarProducts"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    if (args.keepProductId === args.mergeProductId) {
      throw new Error("No se puede fusionar un producto consigo mismo");
    }
    const keep = await ctx.db.get(args.keepProductId);
    const merge = await ctx.db.get(args.mergeProductId);
    if (!keep || !merge) throw new Error("Producto no encontrado");

    const listings = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_product", (q) => q.eq("productId", args.mergeProductId))
      .collect();
    for (const listing of listings) {
      await ctx.db.patch(listing._id, { productId: args.keepProductId });
    }

    const aliases = await ctx.db
      .query("radarProductAliases")
      .withIndex("by_product", (q) => q.eq("productId", args.mergeProductId))
      .collect();
    for (const alias of aliases) {
      await ctx.db.patch(alias._id, { productId: args.keepProductId });
    }
    await ctx.db.insert("radarProductAliases", {
      productId: args.keepProductId,
      alias: merge.canonicalName,
      normalizedAlias: normalizeAlias(merge.canonicalName),
      source: "simulated",
      createdAt: Date.now(),
    });

    const snaps = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product", (q) => q.eq("productId", args.mergeProductId))
      .collect();
    for (const snap of snaps) {
      await ctx.db.patch(snap._id, { productId: args.keepProductId });
    }

    await ctx.db.patch(args.mergeProductId, {
      status: "archived",
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.keepProductId, { updatedAt: Date.now() });
    return null;
  },
});

export const detachListing = mutation({
  args: {
    listingId: v.id("radarMarketplaceListings"),
    newCanonicalName: v.string(),
  },
  returns: v.id("radarProducts"),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const listing = await ctx.db.get(args.listingId);
    if (!listing) throw new Error("Listing not found");
    const now = Date.now();
    const slug = normalizeAlias(args.newCanonicalName).replace(/\s+/g, "-");
    const productId = await ctx.db.insert("radarProducts", {
      canonicalName: args.newCanonicalName.trim(),
      slug: `${slug}-${now.toString(36)}`,
      status: "tracked",
      country: "AR",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(args.listingId, { productId });
    await ctx.db.insert("radarProductAliases", {
      productId,
      alias: args.newCanonicalName,
      normalizedAlias: normalizeAlias(args.newCanonicalName),
      source: listing.source,
      createdAt: now,
    });
    return productId;
  },
});
