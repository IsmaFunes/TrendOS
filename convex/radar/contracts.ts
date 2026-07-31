/**
 * Decoupled data-source contracts for Trend Radar.
 * Implementations live in providers/* — scoring must not import marketplace SDKs.
 */

import type { DataSource } from "./validators";

export type SearchProductsInput = {
  query: string;
  country?: string;
  categoryExternalId?: string;
  limit?: number;
  offset?: number;
};

export type ExternalProduct = {
  externalId: string;
  source: DataSource;
  title: string;
  externalUrl?: string;
  price?: number;
  originalPrice?: number;
  currency?: string;
  sellerId?: string;
  sellerName?: string;
  availableQuantity?: number;
  condition?: string;
  categoryExternalId?: string;
  reviewCount?: number;
  rating?: number;
  soldQuantity?: number;
  searchPosition?: number;
  brand?: string;
  model?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type TrackedProduct = {
  productId: string;
  canonicalName: string;
  listings: Array<{
    listingId: string;
    source: DataSource;
    externalId: string;
    externalUrl?: string;
  }>;
};

export type ProductObservation = {
  source: DataSource;
  externalId?: string;
  listingId?: string;
  capturedAt: number;
  price?: number;
  originalPrice?: number;
  reviewCount?: number;
  rating?: number;
  soldQuantity?: number;
  availableQuantity?: number;
  searchPosition?: number;
  sellerCount?: number;
  listingCount?: number;
  mentionCount?: number;
  viewCount?: number;
  searchInterest?: number;
  isAvailable?: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  partial?: boolean;
  errorType?: string;
};

export type TrendingTermsInput = {
  country?: string;
  categoryHint?: string;
  terms?: string[];
};

export type TrendingTermObservation = {
  term: string;
  source: DataSource;
  capturedAt: number;
  interest?: number;
  relativeInterest?: number;
  growth7d?: number;
  growth30d?: number;
  breakout?: boolean;
  regionData?: Array<{ region: string; interest: number }>;
  relatedQueries?: Array<{
    query: string;
    kind: "rising" | "top" | "breakout";
    interest?: number;
  }>;
  /** Google Trends values are relative, not absolute volumes. */
  isRelative: true;
};

export type CollectResult<T> = {
  items: T[];
  errors: Array<{ message: string; errorType: string; externalId?: string }>;
  partial: boolean;
};

/**
 * Common contract every Trend Radar source implements.
 * Optional methods allow marketplace-only or trends-only providers.
 */
export interface TrendDataSource {
  source: DataSource;

  searchProducts?(
    input: SearchProductsInput,
  ): Promise<CollectResult<ExternalProduct>>;

  collectProductMetrics?(
    product: TrackedProduct,
  ): Promise<CollectResult<ProductObservation>>;

  collectTrendingTerms?(
    input: TrendingTermsInput,
  ): Promise<CollectResult<TrendingTermObservation>>;
}

/** Future social providers share this shape. */
export type SocialSignalInput = {
  productId: string;
  source: DataSource;
  capturedAt?: number;
  mentionCount?: number;
  viewCount?: number;
  creatorCount?: number;
  engagementCount?: number;
  purchaseIntentCount?: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export interface SocialSignalsProvider {
  source: DataSource;
  ingest(signals: SocialSignalInput[]): Promise<CollectResult<SocialSignalInput>>;
}
