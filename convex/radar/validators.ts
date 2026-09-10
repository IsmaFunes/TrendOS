import { v } from "convex/values";

/** Data source identifiers — extend without rewriting core. */
export const dataSourceValidator = v.union(
  v.literal("mercadolibre"),
  v.literal("google_trends"),
  /** @deprecated Historical agent pipeline tag — kept for existing snapshots. */
  v.literal("trends_agent"),
  /** @deprecated Historical agent pipeline tag. */
  v.literal("discovery_agent"),
  /** @deprecated Historical agent pipeline tag. */
  v.literal("commerce_agent"),
  /** @deprecated Historical agent pipeline tag. */
  v.literal("sourcing_agent"),
  v.literal("manual_social"),
  v.literal("tiktok"),
  v.literal("instagram"),
  v.literal("youtube"),
  v.literal("reddit"),
  v.literal("amazon"),
  v.literal("aliexpress"),
  v.literal("google_ads"),
  v.literal("wholesale"),
  v.literal("gemini_research"),
  v.literal("made_in_china"),
  v.literal("alibaba"),
  v.literal("meta_ad_library"),
  v.literal("google_shopping"),
  v.literal("retailer_research"),
  /** Real scraped data (own site's embedded JSON or public API), not an LLM guess — see providers/fravega.ts, providers/vtexRetailer.ts. */
  v.literal("retailer_scrape"),
  v.literal("simulated"),
);

export const productStatusValidator = v.union(
  v.literal("active"),
  v.literal("tracked"),
  v.literal("archived"),
  v.literal("pending_review"),
);

export const classificationValidator = v.union(
  v.literal("EMERGING"),
  v.literal("CONFIRMED"),
  v.literal("SATURATING"),
  v.literal("SEASONAL"),
  v.literal("FALSE_SIGNAL"),
  v.literal("INSUFFICIENT_DATA"),
);

export const jobTypeValidator = v.union(
  v.literal("DiscoverProducts"),
  v.literal("EnrichFromMarketplaces"),
  v.literal("EnrichFromWholesale"),
  v.literal("CollectMarketplaceSnapshots"),
  v.literal("CalculateFeatures"),
  v.literal("CalculateScores"),
  v.literal("MarkInactiveListings"),
  v.literal("SeedDemo"),
  v.literal("CollectMetaAds"),
);

export const jobStatusValidator = v.union(
  v.literal("PENDING"),
  v.literal("RUNNING"),
  v.literal("COMPLETED"),
  v.literal("COMPLETED_WITH_ERRORS"),
  v.literal("FAILED"),
);

export const reviewStatusValidator = v.union(
  v.literal("pending"),
  v.literal("merged"),
  v.literal("kept_separate"),
  v.literal("dismissed"),
);

export const scoreFactorValidator = v.object({
  name: v.string(),
  value: v.number(),
  contribution: v.optional(v.number()),
  penalty: v.optional(v.number()),
});

export const explanationValidator = v.object({
  positiveFactors: v.array(scoreFactorValidator),
  negativeFactors: v.array(scoreFactorValidator),
  dataQuality: v.object({
    availableSources: v.number(),
    expectedSources: v.number(),
    historyDays: v.number(),
    missingFields: v.optional(v.array(v.string())),
  }),
  whyRising: v.optional(v.array(v.string())),
  confirmingSignals: v.optional(v.array(v.string())),
  reducingFactors: v.optional(v.array(v.string())),
  missingData: v.optional(v.array(v.string())),
  confirmingRoles: v.optional(
    v.array(
      v.union(
        v.literal("attention"),
        v.literal("commerce"),
        v.literal("sourcing"),
      ),
    ),
  ),
  confirmingSources: v.optional(v.array(v.string())),
});

export type DataSource =
  | "mercadolibre"
  | "google_trends"
  | "trends_agent"
  | "discovery_agent"
  | "commerce_agent"
  | "sourcing_agent"
  | "manual_social"
  | "tiktok"
  | "instagram"
  | "youtube"
  | "reddit"
  | "amazon"
  | "aliexpress"
  | "google_ads"
  | "wholesale"
  | "gemini_research"
  | "made_in_china"
  | "alibaba"
  | "meta_ad_library"
  | "google_shopping"
  | "retailer_research"
  | "retailer_scrape"
  | "simulated";

export type Classification =
  | "EMERGING"
  | "CONFIRMED"
  | "SATURATING"
  | "SEASONAL"
  | "FALSE_SIGNAL"
  | "INSUFFICIENT_DATA";

export type JobType =
  | "DiscoverProducts"
  | "EnrichFromMarketplaces"
  | "EnrichFromWholesale"
  | "CollectMarketplaceSnapshots"
  | "CalculateFeatures"
  | "CalculateScores"
  | "MarkInactiveListings"
  | "SeedDemo"
  | "CollectMetaAds";

export type JobStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "FAILED";

export type SignalRole = "attention" | "commerce" | "sourcing";

export const businessGoalValidator = v.union(
  v.literal("start_ecommerce"),
  v.literal("create_store"),
  v.literal("add_products"),
  v.literal("grow_sales"),
  v.literal("browse_ads"),
);

export type BusinessGoal =
  | "start_ecommerce"
  | "create_store"
  | "add_products"
  | "grow_sales"
  | "browse_ads";

export const SCORING_VERSION = "radar-v2";

/** Default opportunity score weights (must sum to 1.0 for positive factors). */
export const DEFAULT_SCORE_WEIGHTS = {
  demandGrowth: 0.25,
  acceleration: 0.15,
  crossSource: 0.15,
  demandSupplyGap: 0.15,
  salesVelocity: 0.1,
  margin: 0.1,
  logistics: 0.1,
} as const;

export const DEFAULT_PENALTY_CAPS = {
  saturation: 20,
  seasonality: 15,
  regulatoryRisk: 15,
  lowConfidence: 15,
  singleSource: 10,
} as const;

// ─── Investigate feature (on-demand per-ad research) ──────────────────

export const investigationStatusValidator = v.union(
  v.literal("ready"),
  v.literal("error"),
);
export type InvestigationStatus = "ready" | "error";

/** Coarse opportunity read for the 0–10 investigation score. */
export const investigationClassificationValidator = v.union(
  v.literal("strong"),
  v.literal("moderate"),
  v.literal("weak"),
);
export type InvestigationClassification = "strong" | "moderate" | "weak";

/** Sourcing countries in scope for the Investigate supplier search. */
export const supplierCountryValidator = v.union(
  v.literal("AR"),
  v.literal("CN"),
  v.literal("BR"),
);
export type SupplierCountry = "AR" | "CN" | "BR";

export const mlMatchBadgeValidator = v.union(
  v.literal("best_match"),
  v.literal("match"),
  v.literal("alternative"),
);
export type MlMatchBadge = "best_match" | "match" | "alternative";

export const investigationScoreBreakdownValidator = v.object({
  adSignal: v.number(),
  mlSignal: v.number(),
  sourcingSignal: v.number(),
  nicheFit: v.number(),
});

export const similarAdResultValidator = v.object({
  adId: v.id("radarAds"),
  pageName: v.string(),
  imageUrl: v.optional(v.string()),
  videoUrl: v.optional(v.string()),
  destinationUrl: v.optional(v.string()),
  snapshotUrl: v.optional(v.string()),
  activeDays: v.number(),
  matchScore: v.number(),
  storeQualityScore: v.number(),
  storeQualityLabel: v.string(),
});

export const mlMatchResultValidator = v.object({
  externalId: v.string(),
  title: v.string(),
  imageUrl: v.optional(v.string()),
  permalink: v.optional(v.string()),
  price: v.optional(v.number()),
  currency: v.optional(v.string()),
  soldQuantity: v.optional(v.number()),
  condition: v.optional(v.string()),
  sellerName: v.optional(v.string()),
  matchScore: v.number(),
  badge: mlMatchBadgeValidator,
  /** See investigate.ts's rankMlMatches for what each `source` value means. */
  source: dataSourceValidator,
});

export const supplierOfferValidator = v.object({
  /** The specific product title the offer is for — lets users verify relevance. */
  title: v.string(),
  supplierName: v.optional(v.string()),
  country: supplierCountryValidator,
  isImport: v.boolean(),
  unitPrice: v.number(),
  currency: v.string(),
  moq: v.optional(v.number()),
  leadTimeDays: v.optional(v.number()),
  url: v.optional(v.string()),
  source: v.string(),
});

export const profitEstimateValidator = v.object({
  bestSupplierPrice: v.optional(v.number()),
  bestSupplierCurrency: v.optional(v.string()),
  bestSupplierCountry: v.optional(supplierCountryValidator),
  estimatedSalePrice: v.optional(v.number()),
  estimatedSaleCurrency: v.optional(v.string()),
  estimatedShippingCost: v.optional(v.number()),
  estimatedAdSpend: v.optional(v.number()),
  estimatedProfit: v.optional(v.number()),
  estimatedMargin: v.optional(v.number()),
  platformFeeRate: v.optional(v.number()),
  shippingCostRate: v.optional(v.number()),
  adSpendRate: v.optional(v.number()),
  /** FX rate actually used to convert the supplier's cost into ARS, if any. */
  fxRateUsed: v.optional(v.number()),
  /** Where fxRateUsed came from, e.g. "blue (dolarapi.com)". */
  fxRateSource: v.optional(v.string()),
  isEstimated: v.boolean(),
  note: v.optional(v.string()),
});
