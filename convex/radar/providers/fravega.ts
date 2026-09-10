/**
 * Fravega Argentina — real product search via the site's own embedded
 * Apollo GraphQL cache (__NEXT_DATA__), not an LLM guess. Fravega's search
 * page isn't behind any bot-gate (confirmed manually: a plain fetch with a
 * normal browser UA returns the real page, no CAPTCHA/redirect) and already
 * embeds the full search results as structured JSON in the page's SSR
 * payload — no rendered-DOM scraping needed, just parsing that JSON.
 */

import type { ExternalProduct } from "../contracts";

const SEARCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

/**
 * The search results live in Apollo's normalized cache under a
 * `ROOT_QUERY.items(<json-encoded filter args>).results(<json-encoded
 * paging args>)` key — the exact key text depends on the query variables
 * (postal code, paging), so it's found by prefix rather than hardcoded.
 */
function findItemsResults(apolloState: Record<string, unknown>): unknown[] {
  const rootQuery = apolloState.ROOT_QUERY;
  if (typeof rootQuery !== "object" || rootQuery === null) return [];
  const root = rootQuery as Record<string, unknown>;
  const itemsKey = Object.keys(root).find((k) => k.startsWith("items("));
  if (!itemsKey) return [];
  const itemsNode = root[itemsKey];
  if (typeof itemsNode !== "object" || itemsNode === null) return [];
  const itemsObj = itemsNode as Record<string, unknown>;
  const resultsKey = Object.keys(itemsObj).find((k) => k.startsWith("results("));
  if (!resultsKey) return [];
  const results = itemsObj[resultsKey];
  return Array.isArray(results) ? results : [];
}

function firstAmount(node: unknown): number | null {
  if (typeof node !== "object" || node === null) return null;
  const amounts = (node as { amounts?: unknown }).amounts;
  if (!Array.isArray(amounts) || amounts.length === 0) return null;
  const min = (amounts[0] as { min?: unknown } | undefined)?.min;
  return typeof min === "number" && min > 0 ? min : null;
}

/** Exported for unit tests — pure parsing, no network. */
export function parseFravegaItem(raw: unknown): ExternalProduct | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const externalId = typeof item.id === "string" ? item.id : null;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const slug = typeof item.slug === "string" ? item.slug : "";
  if (!externalId || !title || !slug) return null;

  // salePrice is the actual charged price when there's a discount; fall
  // back to listPrice (no discount active) — never invent a price.
  const price = firstAmount(item.salePrice) ?? firstAmount(item.listPrice);
  if (price == null) return null;

  const skusResults = (item.skus as { results?: unknown } | undefined)
    ?.results;
  const skuCode = Array.isArray(skusResults)
    ? (skusResults[0] as { code?: unknown } | undefined)?.code
    : undefined;
  // The product page URL is "/p/{slug}-{skuCode}/" — slug alone 404s.
  const urlSlug =
    typeof skuCode === "string" || typeof skuCode === "number"
      ? `${slug}-${skuCode}`
      : slug;

  const images = Array.isArray(item.images) ? item.images : [];
  const firstImage = typeof images[0] === "string" ? images[0] : undefined;
  const brand = item.brand as { name?: unknown } | undefined;
  const brandName = typeof brand?.name === "string" ? brand.name : undefined;

  return {
    externalId,
    source: "retailer_scrape",
    title: title.slice(0, 200),
    externalUrl: `https://www.fravega.com/p/${urlSlug}/`,
    imageUrl: firstImage
      ? `https://images.fravega.com/f500/${firstImage}`
      : undefined,
    price,
    currency: "ARS",
    sellerName: brandName ?? "Fravega",
  };
}

/** Exported for unit tests — pure parsing, no network. */
export function parseFravegaSearchHtml(html: string): ExternalProduct[] {
  const match = html.match(NEXT_DATA_RE);
  if (!match) return [];
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch {
    return [];
  }
  const apolloState = (
    data as { props?: { pageProps?: { __APOLLO_STATE__?: unknown } } }
  )?.props?.pageProps?.__APOLLO_STATE__;
  if (typeof apolloState !== "object" || apolloState === null) return [];
  const rawItems = findItemsResults(apolloState as Record<string, unknown>);
  const parsed: ExternalProduct[] = [];
  for (const raw of rawItems) {
    const item = parseFravegaItem(raw);
    if (item) parsed.push(item);
  }
  return parsed;
}

/**
 * Real Fravega search results — no LLM involved, no bot-gate to defeat.
 * Best-effort: any network/parse failure returns an empty list rather than
 * throwing, since this is one of several parallel sources in Investigate.
 */
export async function searchFravega(
  query: string,
  options?: { limit?: number; timeoutMs?: number },
): Promise<ExternalProduct[]> {
  const limit = options?.limit ?? 8;
  const url = `https://www.fravega.com/l/?keyword=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? SEARCH_TIMEOUT_MS,
  );
  let html: string;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "es-AR,es;q=0.9",
      },
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  return parseFravegaSearchHtml(html).slice(0, limit);
}
