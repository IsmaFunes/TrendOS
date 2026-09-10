/**
 * VTEX-powered AR retailer storefronts — real product search via VTEX's
 * public Intelligent Search API. This isn't a private/authenticated
 * endpoint: it's what the storefront's own frontend calls, publicly
 * reachable with no API key, and confirmed working manually against OnCity
 * (an "aremsaprod" VTEX account) with no bot-gate or CAPTCHA.
 *
 * To add another retailer: confirm it actually runs VTEX (its search page
 * calls `{domain}/api/io/_v/api/intelligent-search/...` and returns JSON —
 * check the network tab or just curl the endpoint below with a real query)
 * and add its domain to KNOWN_VTEX_RETAILERS. Don't guess; a non-VTEX
 * domain here just returns empty results, which is harmless but useless.
 */

import type { ExternalProduct } from "../contracts";
import { fetchJsonWithRetry, structuredLog } from "../http";

export type VtexRetailer = {
  name: string;
  domain: string;
};

export const KNOWN_VTEX_RETAILERS: readonly VtexRetailer[] = [
  { name: "OnCity", domain: "www.oncity.com" },
];

type VtexImage = { imageUrl?: unknown };
type VtexSkuItem = { images?: VtexImage[] };
type VtexProduct = {
  productId?: unknown;
  productName?: unknown;
  brand?: unknown;
  link?: unknown;
  priceRange?: { sellingPrice?: { lowPrice?: unknown } };
  items?: VtexSkuItem[];
};
type VtexSearchResponse = { products?: VtexProduct[] };

/** Exported for unit tests — pure parsing, no network. */
export function parseVtexProduct(
  raw: VtexProduct,
  retailer: VtexRetailer,
): ExternalProduct | null {
  const externalId = typeof raw.productId === "string" ? raw.productId : "";
  const title =
    typeof raw.productName === "string" ? raw.productName.trim() : "";
  const link = typeof raw.link === "string" ? raw.link : "";
  const price = raw.priceRange?.sellingPrice?.lowPrice;
  if (
    !externalId ||
    !title ||
    !link ||
    typeof price !== "number" ||
    !(price > 0)
  ) {
    return null;
  }
  const imageUrl = raw.items?.[0]?.images?.[0]?.imageUrl;
  const brand = typeof raw.brand === "string" && raw.brand ? raw.brand : null;

  return {
    // Namespaced by domain — VTEX productIds aren't unique across stores.
    externalId: `${retailer.domain}:${externalId}`,
    source: "retailer_scrape",
    title: title.slice(0, 200),
    externalUrl: link.startsWith("http")
      ? link
      : `https://${retailer.domain}${link}`,
    imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
    price,
    currency: "ARS",
    sellerName: brand ?? retailer.name,
  };
}

/**
 * Real search results from one VTEX-powered retailer — no LLM involved.
 * Best-effort: any network/parse failure returns an empty list rather than
 * throwing, since this is one of several parallel sources in Investigate.
 */
export async function searchVtexRetailer(
  retailer: VtexRetailer,
  query: string,
  options?: { limit?: number; timeoutMs?: number },
): Promise<ExternalProduct[]> {
  const limit = options?.limit ?? 8;
  const url = `https://${retailer.domain}/api/io/_v/api/intelligent-search/product_search/${encodeURIComponent(query)}?query=${encodeURIComponent(query)}&count=${limit}`;

  const result = await fetchJsonWithRetry<VtexSearchResponse>({
    url,
    timeoutMs: options?.timeoutMs ?? 10_000,
    headers: { Accept: "application/json" },
  });

  if (!result.ok) {
    structuredLog({
      source: "vtex_retailer",
      errorType: result.errorType,
      message: `${retailer.name}: ${result.message}`,
    });
    return [];
  }

  const products = result.data.products ?? [];
  const parsed: ExternalProduct[] = [];
  for (const raw of products) {
    const item = parseVtexProduct(raw, retailer);
    if (item) parsed.push(item);
  }
  return parsed.slice(0, limit);
}

/** Searches every known VTEX retailer in parallel and merges results. */
export async function searchAllVtexRetailers(
  query: string,
  options?: { limitPerRetailer?: number; timeoutMs?: number },
): Promise<ExternalProduct[]> {
  const results = await Promise.all(
    KNOWN_VTEX_RETAILERS.map((retailer) =>
      searchVtexRetailer(retailer, query, {
        limit: options?.limitPerRetailer,
        timeoutMs: options?.timeoutMs,
      }),
    ),
  );
  return results.flat();
}
