/**
 * Mercado Libre Argentina collector (official API).
 *
 * Limitations:
 * - sold_quantity / reviews may be absent depending on API surface and auth.
 * - Scraping is intentionally NOT used here; incomplete fields stay undefined.
 * - Rate limits / 429 are handled with backoff via fetchJsonWithRetry.
 */

import type {
  CollectResult,
  ExternalProduct,
  ProductObservation,
  SearchProductsInput,
  TrackedProduct,
  TrendDataSource,
} from "../contracts";
import {
  createRateLimiter,
  fetchJsonWithRetry,
  structuredLog,
} from "../http";

type MlSearchResult = {
  results?: Array<{
    id: string;
    title: string;
    price?: number;
    original_price?: number | null;
    currency_id?: string;
    permalink?: string;
    available_quantity?: number;
    condition?: string;
    category_id?: string;
    seller?: { id?: number; nickname?: string };
    sold_quantity?: number;
  }>;
  paging?: { total?: number; offset?: number; limit?: number };
};

type MlItem = {
  id: string;
  title?: string;
  price?: number;
  original_price?: number | null;
  currency_id?: string;
  permalink?: string;
  available_quantity?: number;
  condition?: string;
  category_id?: string;
  seller_id?: number;
  sold_quantity?: number;
  status?: string;
};

function siteFromCountry(country?: string): string {
  return country === "AR" || !country ? "MLA" : country;
}

export type MercadoLibreConfig = {
  accessToken?: string | null;
  maxRequestsPerMinute?: number;
  timeoutMs?: number;
  jobId?: string;
};

export function createMercadoLibreProvider(
  config: MercadoLibreConfig = {},
): TrendDataSource {
  const limiter = createRateLimiter(config.maxRequestsPerMinute ?? 30);
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (config.accessToken) {
      headers.Authorization = `Bearer ${config.accessToken}`;
    }
    return headers;
  }

  return {
    source: "mercadolibre",

    async searchProducts(
      input: SearchProductsInput,
    ): Promise<CollectResult<ExternalProduct>> {
      const site = siteFromCountry(input.country);
      const limit = Math.min(input.limit ?? 20, 50);
      const offset = input.offset ?? 0;
      const params = new URLSearchParams({
        q: input.query,
        limit: String(limit),
        offset: String(offset),
      });
      if (input.categoryExternalId) {
        params.set("category", input.categoryExternalId);
      }

      const url = `https://api.mercadolibre.com/sites/${site}/search?${params}`;
      const started = Date.now();
      const result = await fetchJsonWithRetry<MlSearchResult>({
        url,
        headers: await authHeaders(),
        timeoutMs,
        beforeAttempt: limiter,
      });

      if (!result.ok) {
        structuredLog({
          jobId: config.jobId,
          source: "mercadolibre",
          errorType: result.errorType,
          attempt: result.attempts,
          duration: Date.now() - started,
          message: result.message,
        });
        return {
          items: [],
          errors: [
            {
              message: result.message,
              errorType: result.errorType,
            },
          ],
          partial: true,
        };
      }

      const items: ExternalProduct[] = [];
      const results = result.data.results ?? [];
      results.forEach((row, index) => {
        items.push({
          externalId: row.id,
          source: "mercadolibre",
          title: row.title,
          externalUrl: row.permalink,
          price: row.price,
          originalPrice: row.original_price ?? undefined,
          currency: row.currency_id,
          sellerId:
            row.seller?.id != null ? String(row.seller.id) : undefined,
          sellerName: row.seller?.nickname,
          availableQuantity: row.available_quantity,
          condition: row.condition,
          categoryExternalId: row.category_id,
          soldQuantity: row.sold_quantity,
          searchPosition: offset + index + 1,
          metadata: {
            pagingTotal: result.data.paging?.total ?? null,
          },
        });
      });

      return { items, errors: [], partial: false };
    },

    async collectProductMetrics(
      product: TrackedProduct,
    ): Promise<CollectResult<ProductObservation>> {
      const observations: ProductObservation[] = [];
      const errors: CollectResult<ProductObservation>["errors"] = [];

      for (const listing of product.listings) {
        if (listing.source !== "mercadolibre") continue;
        const started = Date.now();
        const url = `https://api.mercadolibre.com/items/${listing.externalId}`;
        const result = await fetchJsonWithRetry<MlItem>({
          url,
          headers: await authHeaders(),
          timeoutMs,
          beforeAttempt: limiter,
        });

        if (!result.ok) {
          structuredLog({
            jobId: config.jobId,
            source: "mercadolibre",
            externalId: listing.externalId,
            productId: product.productId,
            errorType: result.errorType,
            attempt: result.attempts,
            duration: Date.now() - started,
            message: result.message,
          });
          if (result.errorType === "not_found") {
            observations.push({
              source: "mercadolibre",
              externalId: listing.externalId,
              listingId: listing.listingId,
              capturedAt: Date.now(),
              isAvailable: false,
              partial: true,
              errorType: "not_found",
            });
          } else {
            errors.push({
              message: result.message,
              errorType: result.errorType,
              externalId: listing.externalId,
            });
          }
          continue;
        }

        const item = result.data;
        const inactive =
          item.status === "closed" ||
          item.status === "inactive" ||
          item.status === "under_review";

        observations.push({
          source: "mercadolibre",
          externalId: item.id,
          listingId: listing.listingId,
          capturedAt: Date.now(),
          price: item.price,
          originalPrice: item.original_price ?? undefined,
          availableQuantity: item.available_quantity,
          soldQuantity: item.sold_quantity,
          isAvailable: !inactive,
          // Reviews/rating often require secondary endpoints and may be unavailable.
          metadata: {
            status: item.status ?? null,
            category_id: item.category_id ?? null,
            seller_id: item.seller_id ?? null,
            reviewsViaApi: false,
          },
          partial: item.sold_quantity == null,
        });
      }

      return {
        items: observations,
        errors,
        partial: errors.length > 0,
      };
    },
  };
}
