import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { requireCurrentUser } from "../lib/auth";
import { normalizeAlias } from "./normalize";
import { periodKeyFromTs } from "./metrics";
import { calculateLogisticsScore, calculateMargin } from "./logistics";
import { computeOpportunityScore } from "./scoring";
import { DEFAULT_AR_SEASONAL_EVENTS, seasonalityAt } from "./seasonality";
import {
  SCORING_VERSION,
  DEFAULT_PENALTY_CAPS,
  DEFAULT_SCORE_WEIGHTS,
  type DataSource,
} from "./validators";
import {
  computeFeaturesFromSnapshots,
  saturationFromFeatures,
  type SnapshotRow,
} from "./features";

const DAY_MS = 24 * 60 * 60 * 1000;

type DemoProfile = {
  slug: string;
  canonicalName: string;
  aliases: string[];
  brand?: string;
  model?: string;
  categorySlug: string;
  classification:
    | "EMERGING"
    | "CONFIRMED"
    | "SATURATING"
    | "SEASONAL"
    | "FALSE_SIGNAL";
  baseSold: number;
  soldGrowthPerDay: number;
  baseInterest: number;
  interestGrowthPerDay: number;
  baseSellers: number;
  sellerGrowthPerDay: number;
  baseListings: number;
  listingGrowthPerDay: number;
  basePrice: number;
  priceDriftPerDay: number;
  baseReviews: number;
  reviewGrowthPerDay: number;
  socialMentionsStart: number;
  socialGrowthPerDay: number;
  socialOnlySpike?: boolean;
  business: {
    purchaseCost: number;
    shippingCost: number;
    taxCost: number;
    platformFee: number;
    packagingCost: number;
    estimatedSalePrice: number;
    weightKg: number;
    widthCm: number;
    heightCm: number;
    depthCm: number;
    regulatoryRisk: number;
    fragility: number;
  };
};

const DEMO_PRODUCTS: DemoProfile[] = [
  {
    slug: "mini-aspiradora-auto-usb",
    canonicalName: "Mini aspiradora auto USB",
    aliases: [
      "aspiradora portátil USB",
      "aspiradora inalámbrica para coche",
      "car vacuum cleaner",
    ],
    brand: "baseus",
    categorySlug: "tecnologia",
    classification: "EMERGING",
    baseSold: 40,
    soldGrowthPerDay: 3.2,
    baseInterest: 28,
    interestGrowthPerDay: 1.4,
    baseSellers: 8,
    sellerGrowthPerDay: 0.15,
    baseListings: 12,
    listingGrowthPerDay: 0.2,
    basePrice: 18900,
    priceDriftPerDay: 20,
    baseReviews: 15,
    reviewGrowthPerDay: 1.1,
    socialMentionsStart: 20,
    socialGrowthPerDay: 2.5,
    business: {
      purchaseCost: 6500,
      shippingCost: 1800,
      taxCost: 1200,
      platformFee: 2200,
      packagingCost: 400,
      estimatedSalePrice: 18900,
      weightKg: 0.45,
      widthCm: 20,
      heightCm: 10,
      depthCm: 10,
      regulatoryRisk: 0.05,
      fragility: 0.2,
    },
  },
  {
    slug: "auriculares-bt-deportivos",
    canonicalName: "Auriculares Bluetooth deportivos",
    aliases: ["earbuds deportivos", "auriculares running bluetooth"],
    brand: "jbl",
    categorySlug: "tecnologia",
    classification: "CONFIRMED",
    baseSold: 120,
    soldGrowthPerDay: 4.5,
    baseInterest: 45,
    interestGrowthPerDay: 0.9,
    baseSellers: 18,
    sellerGrowthPerDay: 0.2,
    baseListings: 30,
    listingGrowthPerDay: 0.25,
    basePrice: 32900,
    priceDriftPerDay: -15,
    baseReviews: 80,
    reviewGrowthPerDay: 2.2,
    socialMentionsStart: 60,
    socialGrowthPerDay: 3,
    business: {
      purchaseCost: 12000,
      shippingCost: 1500,
      taxCost: 2000,
      platformFee: 3800,
      packagingCost: 350,
      estimatedSalePrice: 32900,
      weightKg: 0.15,
      widthCm: 12,
      heightCm: 8,
      depthCm: 4,
      regulatoryRisk: 0.05,
      fragility: 0.3,
    },
  },
  {
    slug: "soporte-celular-magnetico-auto",
    canonicalName: "Soporte celular magnético auto",
    aliases: ["magnetic phone mount", "soporte imán auto"],
    categorySlug: "tecnologia",
    classification: "SATURATING",
    baseSold: 200,
    soldGrowthPerDay: 1.2,
    baseInterest: 55,
    interestGrowthPerDay: 0.3,
    baseSellers: 40,
    sellerGrowthPerDay: 1.8,
    baseListings: 90,
    listingGrowthPerDay: 2.5,
    basePrice: 9900,
    priceDriftPerDay: -80,
    baseReviews: 200,
    reviewGrowthPerDay: 1.5,
    socialMentionsStart: 40,
    socialGrowthPerDay: 0.5,
    business: {
      purchaseCost: 2800,
      shippingCost: 900,
      taxCost: 600,
      platformFee: 1100,
      packagingCost: 200,
      estimatedSalePrice: 9900,
      weightKg: 0.2,
      widthCm: 10,
      heightCm: 10,
      depthCm: 5,
      regulatoryRisk: 0.02,
      fragility: 0.1,
    },
  },
  {
    slug: "luces-navidad-inteligentes",
    canonicalName: "Luces de Navidad inteligentes",
    aliases: ["smart christmas lights", "guirnalda led wifi"],
    categorySlug: "home-deco",
    classification: "SEASONAL",
    baseSold: 30,
    soldGrowthPerDay: 0.2,
    baseInterest: 20,
    interestGrowthPerDay: 0.1,
    baseSellers: 10,
    sellerGrowthPerDay: 0.1,
    baseListings: 15,
    listingGrowthPerDay: 0.1,
    basePrice: 24900,
    priceDriftPerDay: 0,
    baseReviews: 25,
    reviewGrowthPerDay: 0.3,
    socialMentionsStart: 10,
    socialGrowthPerDay: 0.2,
    business: {
      purchaseCost: 9000,
      shippingCost: 2500,
      taxCost: 1500,
      platformFee: 2800,
      packagingCost: 500,
      estimatedSalePrice: 24900,
      weightKg: 0.8,
      widthCm: 30,
      heightCm: 20,
      depthCm: 10,
      regulatoryRisk: 0.1,
      fragility: 0.4,
    },
  },
  {
    slug: "gadget-viral-tiktok-xyz",
    canonicalName: "Gadget viral TikTok XYZ",
    aliases: ["producto viral redes", "tiktok must have xyz"],
    categorySlug: "belleza",
    classification: "FALSE_SIGNAL",
    baseSold: 15,
    soldGrowthPerDay: -0.2,
    baseInterest: 25,
    interestGrowthPerDay: 0.05,
    baseSellers: 5,
    sellerGrowthPerDay: 0.05,
    baseListings: 6,
    listingGrowthPerDay: 0.05,
    basePrice: 7900,
    priceDriftPerDay: 0,
    baseReviews: 4,
    reviewGrowthPerDay: 0,
    socialMentionsStart: 5,
    socialGrowthPerDay: 8,
    socialOnlySpike: true,
    business: {
      purchaseCost: 2000,
      shippingCost: 1200,
      taxCost: 500,
      platformFee: 900,
      packagingCost: 250,
      estimatedSalePrice: 7900,
      weightKg: 0.3,
      widthCm: 15,
      heightCm: 10,
      depthCm: 8,
      regulatoryRisk: 0.15,
      fragility: 0.25,
    },
  },
];

async function upsertSeasonalEvents(ctx: MutationCtx): Promise<void> {
  for (const event of DEFAULT_AR_SEASONAL_EVENTS) {
    const existing = await ctx.db
      .query("radarSeasonalEvents")
      .withIndex("by_slug_country", (q) =>
        q.eq("slug", event.slug).eq("country", event.country),
      )
      .unique();
    if (existing) continue;
    await ctx.db.insert("radarSeasonalEvents", {
      ...event,
      isActive: true,
    });
  }
}

async function runSeed(
  ctx: MutationCtx,
  force: boolean,
): Promise<{ products: number; snapshots: number }> {
  const existingDemo = await ctx.db
    .query("radarProducts")
    .withIndex("by_slug", (q) => q.eq("slug", DEMO_PRODUCTS[0]!.slug))
    .unique();
  if (existingDemo && !force) {
    return { products: 0, snapshots: 0 };
  }

  await upsertSeasonalEvents(ctx);

  const activeConfig = await ctx.db
    .query("radarScoringConfig")
    .withIndex("by_active", (q) => q.eq("isActive", true))
    .first();
  if (!activeConfig) {
    await ctx.db.insert("radarScoringConfig", {
      version: SCORING_VERSION,
      weightsJson: JSON.stringify(DEFAULT_SCORE_WEIGHTS),
      penaltyCapsJson: JSON.stringify(DEFAULT_PENALTY_CAPS),
      classificationRulesJson: JSON.stringify({
        emergingMinScore: 70,
        confirmedMinScore: 75,
        minHistoryDays: 7,
      }),
      isActive: true,
      createdAt: Date.now(),
    });
  }

  const searchTerms = [
    "mini aspiradora auto",
    "auriculares bluetooth deportivos",
    "soporte celular auto",
    "luces navidad led",
    "gadget viral",
  ];
  for (const term of searchTerms) {
    const normalized = normalizeAlias(term);
    const found = await ctx.db
      .query("radarSearchTerms")
      .withIndex("by_normalized_country", (q) =>
        q.eq("normalizedTerm", normalized).eq("country", "AR"),
      )
      .unique();
    if (!found) {
      await ctx.db.insert("radarSearchTerms", {
        term,
        normalizedTerm: normalized,
        country: "AR",
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  const now = Date.now();
  const seasonalAsOf = Date.UTC(2025, 11, 20);
  let snapshotCount = 0;
  let productCount = 0;

  for (const demo of DEMO_PRODUCTS) {
    const category = await ctx.db
      .query("categories")
      .withIndex("by_slug", (q) => q.eq("slug", demo.categorySlug))
      .unique();

    let product = await ctx.db
      .query("radarProducts")
      .withIndex("by_slug", (q) => q.eq("slug", demo.slug))
      .unique();

    if (!product) {
      const productId = await ctx.db.insert("radarProducts", {
        canonicalName: demo.canonicalName,
        slug: demo.slug,
        description: `Producto demo Trend Radar: ${demo.classification}`,
        brand: demo.brand,
        model: demo.model,
        categoryId: category?._id,
        status: "tracked",
        country: "AR",
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      });
      product = await ctx.db.get(productId);
      if (!product) continue;
    }
    productCount += 1;

    for (const alias of demo.aliases) {
      const normalizedAlias = normalizeAlias(alias);
      const existingAlias = await ctx.db
        .query("radarProductAliases")
        .withIndex("by_product_and_normalized", (q) =>
          q
            .eq("productId", product._id)
            .eq("normalizedAlias", normalizedAlias),
        )
        .unique();
      if (!existingAlias) {
        await ctx.db.insert("radarProductAliases", {
          productId: product._id,
          alias,
          normalizedAlias,
          source: "simulated",
          createdAt: now,
        });
      }
    }

    const listingExternalId = `MLA-DEMO-${demo.slug}`;
    let listing = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_source_external", (q) =>
        q.eq("source", "mercadolibre").eq("externalId", listingExternalId),
      )
      .unique();
    if (!listing) {
      const listingId = await ctx.db.insert("radarMarketplaceListings", {
        productId: product._id,
        source: "mercadolibre",
        externalId: listingExternalId,
        externalUrl: `https://articulo.mercadolibre.com.ar/${listingExternalId}`,
        title: demo.canonicalName,
        sellerId: "demo-seller-1",
        sellerName: "Demo Seller",
        currency: "ARS",
        currentPrice: demo.basePrice,
        originalPrice: demo.basePrice * 1.15,
        availableQuantity: 25,
        condition: "new",
        firstSeenAt: now - 30 * DAY_MS,
        lastSeenAt: now,
        isActive: true,
        metadataJson: JSON.stringify({ demo: true }),
      });
      listing = await ctx.db.get(listingId);
    }

    const margin = calculateMargin(demo.business);
    const logistics = calculateLogisticsScore(demo.business);
    const existingBiz = await ctx.db
      .query("radarProductBusinessData")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .unique();
    if (!existingBiz) {
      await ctx.db.insert("radarProductBusinessData", {
        productId: product._id,
        ...demo.business,
        estimatedProfit: margin.estimatedProfit ?? undefined,
        estimatedMargin: margin.estimatedMargin ?? undefined,
        logisticsScore: logistics,
        updatedAt: now,
      });
    }

    const asOf = demo.classification === "SEASONAL" ? seasonalAsOf : now;

    for (let day = 30; day >= 0; day--) {
      const capturedAt = asOf - day * DAY_MS;
      const periodKey = periodKeyFromTs(capturedAt);
      const dayIndex = 30 - day;

      let interest = demo.baseInterest + demo.interestGrowthPerDay * dayIndex;
      let sold = demo.baseSold + demo.soldGrowthPerDay * dayIndex;
      const sellers = demo.baseSellers + demo.sellerGrowthPerDay * dayIndex;
      const listingsQty =
        demo.baseListings + demo.listingGrowthPerDay * dayIndex;
      const price = demo.basePrice + demo.priceDriftPerDay * dayIndex;
      const reviews = demo.baseReviews + demo.reviewGrowthPerDay * dayIndex;
      let mentions =
        demo.socialMentionsStart + demo.socialGrowthPerDay * dayIndex;

      if (demo.classification === "SEASONAL" && day <= 10) {
        interest += (10 - day) * 5;
        sold += (10 - day) * 4;
      }
      if (demo.socialOnlySpike && day > 7) {
        mentions = demo.socialMentionsStart;
      }

      const existingMl = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", product._id)
            .eq("source", "mercadolibre")
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!existingMl) {
        await ctx.db.insert("radarProductSnapshots", {
          productId: product._id,
          listingId: listing?._id,
          source: "mercadolibre",
          capturedAt,
          periodKey,
          price: Math.round(price),
          originalPrice: Math.round(price * 1.1),
          reviewCount: Math.max(0, Math.round(reviews)),
          rating: 4.2,
          soldQuantity: Math.max(0, Math.round(sold)),
          availableQuantity: 20,
          sellerCount: Math.max(1, Math.round(sellers)),
          listingCount: Math.max(1, Math.round(listingsQty)),
          metadataJson: JSON.stringify({ demo: true }),
        });
        snapshotCount += 1;
      }

      const existingGt = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", product._id)
            .eq("source", "google_trends")
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!existingGt) {
        await ctx.db.insert("radarProductSnapshots", {
          productId: product._id,
          source: "google_trends",
          capturedAt,
          periodKey,
          searchInterest: Math.min(100, Math.max(0, Math.round(interest))),
          metadataJson: JSON.stringify({ demo: true, relative: true }),
        });
        snapshotCount += 1;
      }

      const existingSocial = await ctx.db
        .query("radarSocialSignals")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", product._id)
            .eq("source", "manual_social")
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!existingSocial) {
        await ctx.db.insert("radarSocialSignals", {
          productId: product._id,
          source: "manual_social",
          capturedAt,
          periodKey,
          mentionCount: Math.max(0, Math.round(mentions)),
          viewCount: Math.max(0, Math.round(mentions * 40)),
          creatorCount: Math.max(1, Math.round(mentions / 5)),
          engagementCount: Math.max(0, Math.round(mentions * 8)),
          purchaseIntentCount: Math.max(
            0,
            Math.round(mentions * (demo.socialOnlySpike ? 0.05 : 0.3)),
          ),
          metadataJson: JSON.stringify({ demo: true }),
        });
      }

      const existingSocialSnap = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", product._id)
            .eq("source", "manual_social")
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!existingSocialSnap) {
        await ctx.db.insert("radarProductSnapshots", {
          productId: product._id,
          source: "manual_social",
          capturedAt,
          periodKey,
          mentionCount: Math.max(0, Math.round(mentions)),
          viewCount: Math.max(0, Math.round(mentions * 40)),
          metadataJson: JSON.stringify({ demo: true }),
        });
        snapshotCount += 1;
      }
    }

    const allSnaps = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .collect();

    const rows: SnapshotRow[] = allSnaps.map((s) => ({
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

    const events = await ctx.db
      .query("radarSeasonalEvents")
      .withIndex("by_country_active", (q) =>
        q.eq("country", "AR").eq("isActive", true),
      )
      .collect();

    for (const windowDays of [7, 30] as const) {
      const features = computeFeaturesFromSnapshots(rows, windowDays, asOf);
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
        seasonalityScore: seasonalityAt(events, asOf, "AR").score,
        estimatedMargin: margin.estimatedMargin ?? undefined,
        logisticsScore: logistics,
        riskScore: demo.business.regulatoryRisk,
        featuresJson: JSON.stringify(features),
      });
    }

    const features7 = computeFeaturesFromSnapshots(rows, 7, asOf);
    const sat = saturationFromFeatures(features7);
    const seasonal = seasonalityAt(events, asOf, "AR").score;
    const result = computeOpportunityScore({
      demandGrowth: features7.demandGrowth,
      demandAcceleration: features7.demandAcceleration,
      crossSourceConfirmation: features7.crossSourceConfirmation,
      demandSupplyGap:
        features7.competitionRatio != null
          ? Math.min(1, features7.competitionRatio / 10) -
            (features7.listingGrowth ?? 0)
          : null,
      salesOrReviewsVelocity:
        features7.salesVelocity ?? features7.reviewsVelocity,
      estimatedMargin: margin.estimatedMargin,
      logisticsScore: logistics,
      saturation: sat,
      seasonality: seasonal,
      regulatoryRisk: demo.business.regulatoryRisk,
      dataQuality: Math.min(1, features7.historyDays / 30),
      sourceCount: features7.sourceCount,
      historyDays: features7.historyDays,
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
  }

  const pending = await ctx.db
    .query("radarReviewQueue")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .first();
  if (!pending) {
    const p1 = await ctx.db
      .query("radarProducts")
      .withIndex("by_slug", (q) => q.eq("slug", DEMO_PRODUCTS[0]!.slug))
      .unique();
    if (p1) {
      await ctx.db.insert("radarReviewQueue", {
        status: "pending",
        candidateProductId: p1._id,
        proposedAlias: "aspiradora coche usb oferta envio gratis",
        matchConfidence: 0.62,
        matchMethod: "text_similarity",
        explanation:
          "Similitud media con mini aspiradora auto — revisar antes de fusionar",
        createdAt: now,
      });
    }
  }

  return { products: productCount, snapshots: snapshotCount };
}

export const seedDemoData = internalMutation({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({
    products: v.number(),
    snapshots: v.number(),
  }),
  handler: async (ctx, args) => {
    return await runSeed(ctx, args.force ?? false);
  },
});

export const seedDemo = mutation({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({
    products: v.number(),
    snapshots: v.number(),
  }),
  handler: async (ctx, args): Promise<{ products: number; snapshots: number }> => {
    await requireCurrentUser(ctx);
    const cat = await ctx.db.query("categories").first();
    if (!cat) {
      throw new Error("Seed categories first: npx convex run categories:seed");
    }
    return await runSeed(ctx, args.force ?? false);
  },
});
