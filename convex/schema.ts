import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  classificationValidator,
  dataSourceValidator,
  explanationValidator,
  investigationClassificationValidator,
  investigationScoreBreakdownValidator,
  investigationStatusValidator,
  jobStatusValidator,
  jobTypeValidator,
  mlMatchResultValidator,
  productStatusValidator,
  profitEstimateValidator,
  reviewStatusValidator,
  similarAdResultValidator,
  supplierOfferValidator,
} from "./radar/validators";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    siteId: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro")),
    refreshIntervalHours: v.number(),
    onboardingComplete: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_clerk", ["clerkId"]),

  businessProfiles: defineTable({
    userId: v.id("users"),
    businessName: v.string(),
    description: v.optional(v.string()),
    channels: v.optional(v.array(v.string())),
    goal: v.optional(
      v.union(
        v.literal("start_ecommerce"),
        v.literal("create_store"),
        v.literal("add_products"),
        v.literal("grow_sales"),
        v.literal("browse_ads"),
      ),
    ),
    existingStoreUrl: v.optional(v.string()),
    monthlyRevenueRange: v.optional(v.string()),
    targetMarginPercent: v.optional(v.number()),
    notes: v.optional(v.string()),
    hasWarehouseStorage: v.optional(v.boolean()),
    storageNotes: v.optional(v.string()),
    logisticsConstraints: v.optional(v.string()),
    /**
     * Fixed catalog niches this store follows — length capped server-side
     * (1 for free plan, up to 3 for pro; convex/users.ts).
     */
    nicheIds: v.array(v.id("radarNiches")),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  categories: defineTable({
    slug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    mlCategoryIds: v.object({
      MLA: v.optional(v.string()),
      MLB: v.optional(v.string()),
      MLM: v.optional(v.string()),
      MLC: v.optional(v.string()),
      MCO: v.optional(v.string()),
    }),
  }).index("by_slug", ["slug"]),

  // ─── Trend Radar module ───────────────────────────────────────────

  /** Normalized product (not a marketplace listing). */
  radarProducts: defineTable({
    canonicalName: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    brand: v.optional(v.string()),
    model: v.optional(v.string()),
    categoryId: v.optional(v.id("categories")),
    status: productStatusValidator,
    country: v.string(),
    isDemo: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status", ["status"])
    .index("by_category", ["categoryId"])
    .index("by_canonical", ["canonicalName"]),

  radarProductAliases: defineTable({
    productId: v.id("radarProducts"),
    alias: v.string(),
    normalizedAlias: v.string(),
    source: dataSourceValidator,
    createdAt: v.number(),
  })
    .index("by_product", ["productId"])
    .index("by_normalized", ["normalizedAlias"])
    .index("by_product_and_normalized", ["productId", "normalizedAlias"]),

  radarMarketplaceListings: defineTable({
    productId: v.id("radarProducts"),
    source: dataSourceValidator,
    externalId: v.string(),
    externalUrl: v.optional(v.string()),
    title: v.string(),
    sellerId: v.optional(v.string()),
    sellerName: v.optional(v.string()),
    currency: v.optional(v.string()),
    currentPrice: v.optional(v.number()),
    originalPrice: v.optional(v.number()),
    availableQuantity: v.optional(v.number()),
    condition: v.optional(v.string()),
    categoryExternalId: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    isActive: v.boolean(),
  })
    .index("by_product", ["productId"])
    .index("by_source_external", ["source", "externalId"])
    .index("by_active", ["isActive"])
    .index("by_source_active", ["source", "isActive"]),

  /**
   * Historical state. Idempotency key: productId + source + periodKey
   * (periodKey = YYYY-MM-DD for daily captures).
   */
  radarProductSnapshots: defineTable({
    productId: v.id("radarProducts"),
    listingId: v.optional(v.id("radarMarketplaceListings")),
    source: dataSourceValidator,
    capturedAt: v.number(),
    /** Daily bucket for idempotent inserts, e.g. "2026-07-23". */
    periodKey: v.string(),
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
    metadataJson: v.optional(v.string()),
  })
    .index("by_product", ["productId"])
    .index("by_product_and_captured", ["productId", "capturedAt"])
    .index("by_product_source_period", ["productId", "source", "periodKey"])
    .index("by_listing_period", ["listingId", "periodKey"]),

  radarSearchTerms: defineTable({
    term: v.string(),
    normalizedTerm: v.string(),
    country: v.string(),
    categoryId: v.optional(v.id("categories")),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_normalized_country", ["normalizedTerm", "country"])
    .index("by_active", ["isActive"])
    .index("by_category", ["categoryId"]),

  radarSearchTermSnapshots: defineTable({
    searchTermId: v.id("radarSearchTerms"),
    source: dataSourceValidator,
    capturedAt: v.number(),
    periodKey: v.string(),
    interest: v.optional(v.number()),
    relativeInterest: v.optional(v.number()),
    growth7d: v.optional(v.number()),
    growth30d: v.optional(v.number()),
    breakout: v.optional(v.boolean()),
    regionDataJson: v.optional(v.string()),
    relatedQueriesJson: v.optional(v.string()),
  })
    .index("by_term", ["searchTermId"])
    .index("by_term_source_period", ["searchTermId", "source", "periodKey"]),

  radarProductFeatures: defineTable({
    productId: v.id("radarProducts"),
    calculatedAt: v.number(),
    windowDays: v.number(),
    demandGrowth: v.optional(v.number()),
    demandVelocity: v.optional(v.number()),
    demandAcceleration: v.optional(v.number()),
    reviewsVelocity: v.optional(v.number()),
    salesVelocity: v.optional(v.number()),
    socialVelocity: v.optional(v.number()),
    sellerGrowth: v.optional(v.number()),
    listingGrowth: v.optional(v.number()),
    competitionRatio: v.optional(v.number()),
    priceChange: v.optional(v.number()),
    crossSourceConfirmation: v.optional(v.number()),
    seasonalityScore: v.optional(v.number()),
    estimatedMargin: v.optional(v.number()),
    logisticsScore: v.optional(v.number()),
    riskScore: v.optional(v.number()),
    featuresJson: v.optional(v.string()),
  })
    .index("by_product", ["productId"])
    .index("by_product_and_calculated", ["productId", "calculatedAt"])
    .index("by_product_window", ["productId", "windowDays"]),

  radarProductScores: defineTable({
    productId: v.id("radarProducts"),
    calculatedAt: v.number(),
    score: v.number(),
    classification: classificationValidator,
    confidence: v.number(),
    explanationJson: explanationValidator,
    scoringVersion: v.string(),
  })
    .index("by_product", ["productId"])
    .index("by_product_and_calculated", ["productId", "calculatedAt"])
    .index("by_score", ["score"])
    .index("by_classification", ["classification"]),

  radarProductBusinessData: defineTable({
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
    estimatedProfit: v.optional(v.number()),
    estimatedMargin: v.optional(v.number()),
    logisticsScore: v.optional(v.number()),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  }).index("by_product", ["productId"]),

  radarSocialSignals: defineTable({
    productId: v.id("radarProducts"),
    source: dataSourceValidator,
    capturedAt: v.number(),
    periodKey: v.string(),
    mentionCount: v.optional(v.number()),
    viewCount: v.optional(v.number()),
    creatorCount: v.optional(v.number()),
    engagementCount: v.optional(v.number()),
    purchaseIntentCount: v.optional(v.number()),
    metadataJson: v.optional(v.string()),
  })
    .index("by_product", ["productId"])
    .index("by_product_source_period", ["productId", "source", "periodKey"]),

  radarJobs: defineTable({
    type: jobTypeValidator,
    status: jobStatusValidator,
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    processedItems: v.number(),
    successfulItems: v.number(),
    failedItems: v.number(),
    errorSummary: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_type", ["type"])
    .index("by_status", ["status"])
    .index("by_type_and_status", ["type", "status"])
    .index("by_created", ["createdAt"]),

  radarReviewQueue: defineTable({
    status: reviewStatusValidator,
    candidateProductId: v.optional(v.id("radarProducts")),
    existingProductId: v.optional(v.id("radarProducts")),
    listingId: v.optional(v.id("radarMarketplaceListings")),
    proposedAlias: v.optional(v.string()),
    matchConfidence: v.number(),
    matchMethod: v.string(),
    explanation: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
    resolutionNote: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  /** Configurable seasonal dates — not hardcoded in scoring logic. */
  radarSeasonalEvents: defineTable({
    name: v.string(),
    slug: v.string(),
    country: v.string(),
    /** Month 1–12; optional day-of-month for fixed dates. */
    month: v.number(),
    dayStart: v.optional(v.number()),
    dayEnd: v.optional(v.number()),
    /** Relative window in days around the event. */
    windowDays: v.number(),
    intensity: v.number(),
    isActive: v.boolean(),
  })
    .index("by_slug_country", ["slug", "country"])
    .index("by_country_active", ["country", "isActive"]),

  radarScoringConfig: defineTable({
    version: v.string(),
    weightsJson: v.string(),
    penaltyCapsJson: v.string(),
    classificationRulesJson: v.string(),
    isActive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_version", ["version"])
    .index("by_active", ["isActive"]),

  /** Real wholesale / supplier catalog offers (imported, never invented). */
  radarWholesaleOffers: defineTable({
    sku: v.string(),
    title: v.string(),
    normalizedTitle: v.string(),
    supplierName: v.optional(v.string()),
    currency: v.string(),
    unitPrice: v.number(),
    moq: v.optional(v.number()),
    leadTimeDays: v.optional(v.number()),
    externalUrl: v.optional(v.string()),
    productId: v.optional(v.id("radarProducts")),
    normalizedAliases: v.array(v.string()),
    metadataJson: v.optional(v.string()),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sku", ["sku"])
    .index("by_normalized_title", ["normalizedTitle"])
    .index("by_product", ["productId"])
    .index("by_active", ["isActive"]),

  // ─── Fixed niche catalog (curated, pre-scraped, shared by all users) ──

  /**
   * A fixed, admin-curated set of niches users pick from at onboarding —
   * replaces the old per-user typed-keyword + Jaccard-fuzzy-matched bucket
   * system. Ads are scraped continuously in the background (daily cron,
   * across every country in scrapeTermsByCountry) so a niche already has
   * ads by the time any user selects it.
   */
  radarNiches: defineTable({
    slug: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    /**
     * Curated Meta Ad Library search terms per country — ad body text is in
     * the advertiser's local language, so a single term list can't serve
     * AR/MX/ES-Spanish, pt-BR and en-US at once. Localized once at seed
     * time (convex/admin/seedNicheCatalog.ts), not regenerated per scrape.
     */
    scrapeTermsByCountry: v.array(
      v.object({ country: v.string(), terms: v.array(v.string()) }),
    ),
    adCount: v.number(),
    lastScrapedAt: v.optional(v.number()),
    /** Reflects scrape health, not per-user readiness — niches are curated. */
    status: v.union(
      v.literal("ready"),
      v.literal("pending_scrape"),
      v.literal("scraping"),
    ),
    /** Lets a niche be pulled from onboarding without deleting its ad history. */
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_active", ["isActive"])
    .index("by_status", ["status"]),

  /**
   * Niche-shared Gemini relevance pass — computed once per niche bucket and
   * is the MANDATORY gate before any ad reaches a user's feed: an ad not
   * present here with score >= 45 is never shown, regardless of sort mode.
   */
  radarNicheAdRelevance: defineTable({
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
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_niche", ["nicheId"]),

  radarNicheAds: defineTable({
    nicheId: v.id("radarNiches"),
    adId: v.id("radarAds"),
    searchTerm: v.optional(v.string()),
    linkedAt: v.number(),
  })
    .index("by_niche", ["nicheId"])
    .index("by_ad", ["adId"])
    .index("by_niche_ad", ["nicheId", "adId"]),

  radarNicheScrapeJobs: defineTable({
    nicheId: v.id("radarNiches"),
    /** Which of the niche's scrapeTermsByCountry entries this job covers. */
    country: v.string(),
    terms: v.array(v.string()),
    // Terms are curated ahead of time (seedNicheCatalog.ts) — no more
    // Gemini per-scrape enrichment step, so no "enriching" pre-claim status.
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_status_created", ["status", "createdAt"])
    .index("by_niche_status", ["nicheId", "status"])
    .index("by_niche_country_status", ["nicheId", "country", "status"]),

  // ─── Meta Ad Library (Argentina MVP) ──────────────────────────────

  radarAdvertisers: defineTable({
    pageId: v.string(),
    pageName: v.string(),
    country: v.string(),
    activeAdCount: v.number(),
    totalAdCount: v.number(),
    /** Facebook page follower count, straight from the Ad Library payload — a real credibility/size signal, not derived from our own scrape. */
    pageLikeCount: v.optional(v.number()),
    pageCategories: v.optional(v.array(v.string())),
    pageProfileUri: v.optional(v.string()),
    pageProfilePictureUrl: v.optional(v.string()),
    /** True once Meta reports the page itself as deleted — the store may no longer exist even if we still have ads cached for it. */
    pageIsDeleted: v.optional(v.boolean()),
    lastSeenAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_country_lastSeen", ["country", "lastSeenAt"]),

  radarStores: defineTable({
    domain: v.string(),
    platform: v.union(
      v.literal("shopify"),
      v.literal("tiendanube"),
      v.literal("mercadolibre"),
      v.literal("custom"),
    ),
    country: v.string(),
    productCount: v.optional(v.number()),
    themeHint: v.optional(v.string()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    metadataJson: v.optional(v.string()),
  })
    .index("by_domain", ["domain"])
    .index("by_country_lastSeen", ["country", "lastSeenAt"]),

  radarAds: defineTable({
    externalAdId: v.string(),
    pageId: v.string(),
    pageName: v.string(),
    country: v.string(),
    platforms: v.array(v.string()),
    body: v.optional(v.string()),
    cta: v.optional(v.string()),
    snapshotUrl: v.optional(v.string()),
    mediaUrls: v.array(v.string()),
    /** Meta Ad Library video creative (sd/hd); used for hover preview. */
    videoUrl: v.optional(v.string()),
    destinationUrl: v.optional(v.string()),
    storeId: v.optional(v.id("radarStores")),
    searchTerm: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    /** How many creative variants Meta reports collated under this ad — a live ad-spend/testing-scale signal for this specific product. */
    collationCount: v.optional(v.number()),
    lastSeenAt: v.number(),
    isActive: v.boolean(),
    metadataJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_external", ["externalAdId"])
    .index("by_country_lastSeen", ["country", "lastSeenAt"])
    .index("by_page", ["pageId"])
    .index("by_destination", ["destinationUrl"])
    .index("by_active_country", ["isActive", "country"])
    // Cross-country candidate pools (e.g. investigate.ts similar-ads) — no
    // longer AR-only, so a plain isActive index without the country partition.
    .index("by_active", ["isActive"]),

  // ─── OAuth token cache (Mercado Libre) ────────────────────────────
  // Singleton row. Mercado Libre refresh tokens are single-use — each
  // refresh call returns a NEW refresh token that must replace the old
  // one, so the working token can't just live in a static env var past
  // the very first call. See convex/radar/providers/mlAuth.ts.
  radarMercadoLibreToken: defineTable({
    accessToken: v.string(),
    accessTokenExpiresAt: v.number(),
    refreshToken: v.string(),
    updatedAt: v.number(),
  }),

  // ─── Investigate (on-demand per-ad research, cached) ────────────────

  /**
   * One row per (adId, userId) investigation run. Written only by the
   * `radar.investigate.investigateAd` action via an internal mutation —
   * never patched directly from client input, so the 0–10 `score` and the
   * 0–1 sub-scores below are always server-computed and clamped before
   * insert, not client-supplied deltas.
   */
  radarAdInvestigations: defineTable({
    adId: v.id("radarAds"),
    userId: v.id("users"),
    productQuery: v.string(),
    status: investigationStatusValidator,
    errorMessage: v.optional(v.string()),
    /**
     * 0–10, clamped in computeInvestigationScore and re-clamped in
     * saveInvestigation before insert — this row is only ever written by
     * that internal mutation, never patched from a public/client mutation.
     */
    score: v.number(),
    classification: investigationClassificationValidator,
    scoreBreakdown: investigationScoreBreakdownValidator,
    similarAds: v.array(similarAdResultValidator),
    mlMatches: v.array(mlMatchResultValidator),
    suppliers: v.array(supplierOfferValidator),
    profit: v.optional(profitEstimateValidator),
    warnings: v.array(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_ad_user", ["adId", "userId"]),
});
