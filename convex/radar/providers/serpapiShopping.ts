/**
 * Argentina retail price search via SerpAPI's Google Shopping engine.
 *
 * Mercado Libre's official product-search API returns a policy 403 for
 * this app regardless of authentication (confirmed against both the
 * anonymous and OAuth-authenticated endpoints — the app was never granted
 * MercadoLibre's elevated API scope), and anonymously fetching
 * mercadolibre.com.ar pages directly — even from a stealth-Playwright
 * browser — gets redirected to an account-verification bot challenge
 * (confirmed from multiple cloud IP ranges, including a GitHub Actions
 * runner). Google's Shopping index already has real AR retailers'
 * listings crawled and priced, MercadoLibre among them but by no means
 * only — SerpAPI surfaces that real, structured data without our server
 * touching any of those sites directly. Originally filtered to
 * MercadoLibre-only results; broadened to keep every real AR retailer
 * Google Shopping already returns for the same query at no extra cost.
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

/**
 * Search Argentina Google Shopping results across every retailer Google
 * has indexed for the query. Real, structured data (title + numeric price
 * + the actual store name) straight from Google's shopping index — no LLM
 * hallucination risk, no need to fetch any retailer's site ourselves.
 */
export async function searchArgentinaShopping(
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
    if (!row.title || !row.source) continue;
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
