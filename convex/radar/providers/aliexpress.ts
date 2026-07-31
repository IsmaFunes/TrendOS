/**
 * AliExpress Affiliate / Open Platform product search.
 *
 * @deprecated Not wired in default Trend Radar path (prefer chinaB2b light fetch).
 * Kept for optional legacy TREND_RADAR_SOURCES=aliexpress setups only.
 *
 * Requires ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_ACCESS_TOKEN.
 * No mocks — fails closed when credentials are missing.
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

export type AliExpressConfig = {
  appKey: string;
  appSecret: string;
  accessToken: string;
  maxRequestsPerMinute?: number;
  timeoutMs?: number;
  jobId?: string;
};

type AeProduct = {
  product_id?: string | number;
  product_title?: string;
  product_detail_url?: string;
  target_sale_price?: string | number;
  target_original_price?: string | number;
  target_sale_price_currency?: string;
  lastest_volume?: string | number;
  evaluate_rate?: string;
  shop_id?: string | number;
  shop_name?: string;
};

type AeSearchResponse = {
  resp_result?: {
    result?: {
      products?: AeProduct[];
    };
  };
  // Some gateway shapes nest differently
  result?: {
    products?: AeProduct[];
  };
  error_response?: { msg?: string; code?: string };
};

function parseNumber(v: string | number | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * AliExpress Open Platform signs requests with HMAC-SHA256 of sorted params.
 * For Convex actions we use Web Crypto.
 */
async function signRequest(
  params: Record<string, string>,
  appSecret: string,
): Promise<string> {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  const payload = `${appSecret}${sorted}${appSecret}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function createAliExpressProvider(
  config: AliExpressConfig,
): TrendDataSource {
  if (!config.appKey || !config.appSecret || !config.accessToken) {
    throw new Error(
      "AliExpress credentials required (APP_KEY, APP_SECRET, ACCESS_TOKEN) — mocks disabled",
    );
  }
  const limiter = createRateLimiter(config.maxRequestsPerMinute ?? 20);
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function callApi(
    method: string,
    businessParams: Record<string, string>,
  ): Promise<FetchResult> {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const params: Record<string, string> = {
      method,
      app_key: config.appKey,
      session: config.accessToken,
      timestamp,
      format: "json",
      v: "2.0",
      sign_method: "sha256",
      ...businessParams,
    };
    params.sign = await signRequest(params, config.appSecret);
    const qs = new URLSearchParams(params).toString();
    const url = `https://api-sg.aliexpress.com/sync?${qs}`;
    return fetchJsonWithRetry<AeSearchResponse>({
      url,
      timeoutMs,
      beforeAttempt: limiter,
    });
  }

  type FetchResult = Awaited<
    ReturnType<typeof fetchJsonWithRetry<AeSearchResponse>>
  >;

  return {
    source: "aliexpress",

    async searchProducts(
      input: SearchProductsInput,
    ): Promise<CollectResult<ExternalProduct>> {
      const started = Date.now();
      const result = await callApi("aliexpress.affiliate.product.query", {
        keywords: input.query,
        page_no: String(Math.floor((input.offset ?? 0) / (input.limit ?? 20)) + 1),
        page_size: String(Math.min(input.limit ?? 20, 50)),
        target_currency: "USD",
        target_language: "EN",
      });

      if (!result.ok) {
        structuredLog({
          jobId: config.jobId,
          source: "aliexpress",
          errorType: result.errorType,
          attempt: result.attempts,
          duration: Date.now() - started,
          message: result.message,
        });
        return {
          items: [],
          errors: [
            { message: result.message, errorType: result.errorType },
          ],
          partial: true,
        };
      }

      if (result.data.error_response) {
        return {
          items: [],
          errors: [
            {
              message:
                result.data.error_response.msg ??
                result.data.error_response.code ??
                "aliexpress error",
              errorType: "api_error",
            },
          ],
          partial: true,
        };
      }

      const products =
        result.data.resp_result?.result?.products ??
        result.data.result?.products ??
        [];

      const items: ExternalProduct[] = products.map((p, index) => {
        const id = String(p.product_id ?? "");
        return {
          externalId: id,
          source: "aliexpress" as const,
          title: p.product_title ?? `AliExpress ${id}`,
          externalUrl: p.product_detail_url,
          price: parseNumber(p.target_sale_price),
          originalPrice: parseNumber(p.target_original_price),
          currency: p.target_sale_price_currency ?? "USD",
          sellerId: p.shop_id != null ? String(p.shop_id) : undefined,
          sellerName: p.shop_name,
          soldQuantity: parseNumber(p.lastest_volume),
          searchPosition: (input.offset ?? 0) + index + 1,
          metadata: {
            evaluate_rate: p.evaluate_rate ?? null,
          },
        };
      });

      return { items, errors: [], partial: false };
    },

    async collectProductMetrics(
      product: TrackedProduct,
    ): Promise<CollectResult<ProductObservation>> {
      const observations: ProductObservation[] = [];
      const errors: CollectResult<ProductObservation>["errors"] = [];
      const now = Date.now();
      const provider = createAliExpressProvider(config);

      for (const listing of product.listings) {
        if (listing.source !== "aliexpress") continue;
        const result = await provider.searchProducts?.({
          query: listing.externalId || product.canonicalName,
          limit: 5,
        });
        if (!result) continue;
        const match =
          result.items.find((i) => i.externalId === listing.externalId) ??
          result.items[0];
        if (!match) {
          errors.push({
            message: "AliExpress listing not found",
            errorType: "not_found",
            externalId: listing.externalId,
          });
          continue;
        }
        observations.push({
          source: "aliexpress",
          externalId: match.externalId,
          listingId: listing.listingId,
          capturedAt: now,
          price: match.price,
          originalPrice: match.originalPrice,
          soldQuantity: match.soldQuantity,
          isAvailable: true,
          partial: match.soldQuantity == null,
          metadata: match.metadata,
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

export function createAliExpressProviderFromEnv(
  jobId?: string,
): TrendDataSource {
  const appKey = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;
  const accessToken = process.env.ALIEXPRESS_ACCESS_TOKEN;
  if (!appKey || !appSecret || !accessToken) {
    throw new Error(
      "AliExpress credentials missing (ALIEXPRESS_APP_KEY/SECRET/ACCESS_TOKEN)",
    );
  }
  return createAliExpressProvider({
    appKey,
    appSecret,
    accessToken,
    jobId,
  });
}
