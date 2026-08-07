/**
 * Mercado Libre Argentina price search via SerpAPI's Google Shopping engine.
 *
 * Mercado Libre's official product-search API returns a policy 403 for
 * unverified third-party apps (confirmed in production: every call fails),
 * and anonymously fetching mercadolibre.com.ar pages directly gets
 * redirected to an account-verification bot challenge. Google's Shopping
 * index already has Mercado Libre listings crawled and priced — SerpAPI
 * surfaces that real, structured data without our server ever touching
 * mercadolibre.com.ar.
 */

import type { ExternalProduct } from "../contracts";
import { fetchJsonWithRetry, structuredLog } from "../http";
import { requireSerpApiKey } from "./registry";

type SerpShoppingResult = {
  position?: number;
  title?: string;
  product_id?: string;
  product_link?: string;
  source?: string;
  extracted_price?: number;
  thumbnail?: string;
};

type SerpShoppingResponse = {
  shopping_results?: SerpShoppingResult[];
};

export type SerpApiShoppingResult = {
  items: ExternalProduct[];
  errors: Array<{ message: string; errorType: string }>;
};

const ML_SOURCE_RE = /mercado\s*libre/i;

/**
 * Search Argentina Google Shopping results, keeping only items sourced
 * from Mercado Libre. Real, structured data (title + numeric price)
 * straight from Google's shopping index — no LLM hallucination risk, no
 * need to fetch mercadolibre.com.ar ourselves.
 */
export async function searchMercadoLibreViaShopping(
  query: string,
  options?: { limit?: number; timeoutMs?: number; maxAttempts?: number },
): Promise<SerpApiShoppingResult> {
  const apiKey = requireSerpApiKey();
  const limit = options?.limit ?? 10;
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    google_domain: "google.com.ar",
    gl: "ar",
    hl: "es",
    api_key: apiKey,
  });

  const result = await fetchJsonWithRetry<SerpShoppingResponse>({
    url: `https://serpapi.com/search.json?${params}`,
    timeoutMs: options?.timeoutMs ?? 15_000,
    maxAttempts: options?.maxAttempts,
  });

  if (!result.ok) {
    structuredLog({
      source: "serpapi_shopping",
      errorType: result.errorType,
      message: result.message,
    });
    return {
      items: [],
      errors: [{ message: result.message, errorType: result.errorType }],
    };
  }

  const rows = result.data.shopping_results ?? [];
  const items: ExternalProduct[] = [];
  for (const row of rows) {
    if (!row.title || !ML_SOURCE_RE.test(row.source ?? "")) continue;
    const price =
      typeof row.extracted_price === "number" && row.extracted_price > 0
        ? row.extracted_price
        : undefined;
    if (price == null) continue;
    items.push({
      externalId: row.product_id ?? row.product_link ?? row.title,
      source: "google_shopping",
      title: row.title.slice(0, 200),
      externalUrl: row.product_link,
      imageUrl: row.thumbnail,
      price,
      currency: "ARS",
      sellerName: row.source,
      searchPosition: row.position,
    });
    if (items.length >= limit) break;
  }

  return { items, errors: [] };
}
