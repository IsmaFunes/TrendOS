/**
 * Light public HTTP fetch for Chinese B2B marketplaces (Made-in-China, Alibaba).
 * No headless browser, no login. Fail-soft on captcha/blocks — never invent listings.
 *
 * @deprecated AliExpress Affiliate path: see providers/aliexpress.ts (not wired by default).
 */

import type { ExternalProduct } from "../contracts";
import { createRateLimiter, structuredLog } from "../http";

const USER_AGENT =
  "TrendOS-Radar/1.0 (+https://github.com/local; research bot; contact: ops)";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 12_000;

export type ChinaB2bSearchResult = {
  items: ExternalProduct[];
  errors: Array<{ message: string; errorType: string }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(
  url: string,
  beforeAttempt?: () => Promise<void>,
): Promise<
  | { ok: true; html: string; status: number }
  | { ok: false; status?: number; message: string; errorType: string }
> {
  if (beforeAttempt) await beforeAttempt();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const html = await res.text();
    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        status: res.status,
        message: `Blocked HTTP ${res.status}`,
        errorType: res.status === 429 ? "rate_limit" : "blocked",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `HTTP ${res.status}`,
        errorType: "http_error",
      };
    }
    const lower = html.toLowerCase();
    if (
      lower.includes("captcha") ||
      lower.includes("cf-challenge") ||
      lower.includes("access denied")
    ) {
      return {
        ok: false,
        status: res.status,
        message: "Captcha or challenge page",
        errorType: "blocked",
      };
    }
    return { ok: true, html, status: res.status };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "fetch failed",
      errorType: "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCharCode(Number(n)),
    );
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function hashId(source: string, url: string, title: string): string {
  const seed = `${source}|${url}|${title}`.slice(0, 200);
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return `${source}_${Math.abs(h)}`;
}

/** Exported for unit tests — Made-in-China HTML cards / JSON-LD. */
export function parseMadeInChinaHtml(
  html: string,
  limit = MAX_RESULTS,
): ExternalProduct[] {
  const items: ExternalProduct[] = [];
  const seen = new Set<string>();

  // JSON-LD Product blocks
  const ldMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of ldMatches) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as unknown;
      const list = Array.isArray(data) ? data : [data];
      for (const node of list) {
        if (typeof node !== "object" || node === null) continue;
        const obj = node as Record<string, unknown>;
        if (obj["@type"] !== "Product" && obj["@type"] !== "ProductGroup") {
          continue;
        }
        const title =
          typeof obj.name === "string" ? stripTags(obj.name) : "";
        const url =
          typeof obj.url === "string"
            ? obj.url
            : typeof obj["@id"] === "string"
              ? obj["@id"]
              : undefined;
        if (!title || title.length < 3) continue;
        const offers = obj.offers as Record<string, unknown> | undefined;
        const price =
          offers && typeof offers.price === "string"
            ? parsePrice(offers.price)
            : offers && typeof offers.price === "number"
              ? offers.price
              : undefined;
        const externalId = hashId("made_in_china", url ?? title, title);
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        items.push({
          externalId,
          source: "made_in_china",
          title: title.slice(0, 200),
          externalUrl: url,
          price,
          currency: "USD",
          searchPosition: items.length + 1,
          metadata: { parser: "json_ld" },
        });
        if (items.length >= limit) return items;
      }
    } catch {
      // ignore bad JSON-LD
    }
  }

  // Anchor cards: productdetail / product links
  const linkRe =
    /<a[^>]+href=["'](https?:\/\/[^"']*made-in-china\.com[^"']*(?:product|productdetail)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && items.length < limit) {
    const url = match[1];
    const title = stripTags(match[2] ?? "");
    if (!url || title.length < 8) continue;
    if (/login|register|help|about/i.test(title)) continue;
    const externalId = hashId("made_in_china", url, title);
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    // Nearby MOQ / price snippets
    const window = html.slice(
      Math.max(0, match.index - 80),
      Math.min(html.length, match.index + 400),
    );
    const moqMatch = window.match(/MOQ[^0-9]*(\d[\d,]*)/i);
    const priceMatch = window.match(/US\s*\$\s*([\d.]+)/i);

    items.push({
      externalId,
      source: "made_in_china",
      title: title.slice(0, 200),
      externalUrl: url,
      price: parsePrice(priceMatch?.[1]),
      currency: "USD",
      availableQuantity: moqMatch
        ? Number(moqMatch[1].replace(/,/g, ""))
        : undefined,
      searchPosition: items.length + 1,
      metadata: {
        parser: "anchor",
        moq: moqMatch?.[1] ?? null,
      },
    });
  }

  return items.slice(0, limit);
}

/** Exported for unit tests — Alibaba search HTML. */
export function parseAlibabaHtml(
  html: string,
  limit = MAX_RESULTS,
): ExternalProduct[] {
  const items: ExternalProduct[] = [];
  const seen = new Set<string>();

  const ldMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of ldMatches) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as unknown;
      const list = Array.isArray(data) ? data : [data];
      for (const node of list) {
        if (typeof node !== "object" || node === null) continue;
        const obj = node as Record<string, unknown>;
        const type = obj["@type"];
        if (type !== "Product" && type !== "ItemList") continue;
        if (type === "ItemList" && Array.isArray(obj.itemListElement)) {
          for (const el of obj.itemListElement) {
            if (typeof el !== "object" || el === null) continue;
            const item = el as Record<string, unknown>;
            const product =
              typeof item.item === "object" && item.item !== null
                ? (item.item as Record<string, unknown>)
                : item;
            const title =
              typeof product.name === "string"
                ? stripTags(product.name)
                : "";
            const url =
              typeof product.url === "string" ? product.url : undefined;
            if (!title || title.length < 3) continue;
            const externalId = hashId("alibaba", url ?? title, title);
            if (seen.has(externalId)) continue;
            seen.add(externalId);
            items.push({
              externalId,
              source: "alibaba",
              title: title.slice(0, 200),
              externalUrl: url,
              currency: "USD",
              searchPosition: items.length + 1,
              metadata: { parser: "json_ld_list" },
            });
            if (items.length >= limit) return items;
          }
          continue;
        }
        const title =
          typeof obj.name === "string" ? stripTags(obj.name) : "";
        const url = typeof obj.url === "string" ? obj.url : undefined;
        if (!title) continue;
        const externalId = hashId("alibaba", url ?? title, title);
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        const offers = obj.offers as Record<string, unknown> | undefined;
        items.push({
          externalId,
          source: "alibaba",
          title: title.slice(0, 200),
          externalUrl: url,
          price:
            offers && typeof offers.lowPrice === "string"
              ? parsePrice(offers.lowPrice)
              : offers && typeof offers.price === "string"
                ? parsePrice(offers.price)
                : undefined,
          currency: "USD",
          searchPosition: items.length + 1,
          metadata: { parser: "json_ld" },
        });
        if (items.length >= limit) return items;
      }
    } catch {
      // ignore
    }
  }

  const linkRe =
    /<a[^>]+href=["'](https?:\/\/(?:www\.)?alibaba\.com\/product-detail\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && items.length < limit) {
    const url = match[1];
    const title = stripTags(match[2] ?? "");
    if (!url || title.length < 8) continue;
    const externalId = hashId("alibaba", url, title);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const window = html.slice(
      Math.max(0, match.index - 40),
      Math.min(html.length, match.index + 350),
    );
    const priceMatch = window.match(/US\s*\$\s*([\d.]+)/i);
    const moqMatch = window.match(/Min\.?\s*Order[^0-9]*(\d[\d,]*)/i);
    items.push({
      externalId,
      source: "alibaba",
      title: title.slice(0, 200),
      externalUrl: url,
      price: parsePrice(priceMatch?.[1]),
      currency: "USD",
      availableQuantity: moqMatch
        ? Number(moqMatch[1].replace(/,/g, ""))
        : undefined,
      searchPosition: items.length + 1,
      metadata: { parser: "anchor", moq: moqMatch?.[1] ?? null },
    });
  }

  return items.slice(0, limit);
}

const micLimiter = createRateLimiter(20);
const aliLimiter = createRateLimiter(20);

export async function searchMadeInChina(
  query: string,
  options?: { limit?: number; jobId?: string },
): Promise<ChinaB2bSearchResult> {
  const limit = options?.limit ?? MAX_RESULTS;
  const q = encodeURIComponent(query.trim().slice(0, 80));
  const url = `https://www.made-in-china.com/productdirectory.do?word=${q}&subaction=hunt&style=b&mode=and&code=0&comProvince=nolimit&order=0&isOpenCorrection=1`;

  const fetched = await fetchHtml(url, () => micLimiter());
  if (!fetched.ok) {
    structuredLog({
      jobId: options?.jobId,
      source: "made_in_china",
      errorType: fetched.errorType,
      message: fetched.message,
    });
    return {
      items: [],
      errors: [
        {
          message: `MIC: ${fetched.message}`,
          errorType: fetched.errorType,
        },
      ],
    };
  }

  const items = parseMadeInChinaHtml(fetched.html, limit);
  if (items.length === 0) {
    return {
      items: [],
      errors: [
        {
          message: "MIC: no products parsed (layout change or empty)",
          errorType: "parse_empty",
        },
      ],
    };
  }
  await sleep(200);
  return { items, errors: [] };
}

export async function searchAlibaba(
  query: string,
  options?: { limit?: number; jobId?: string },
): Promise<ChinaB2bSearchResult> {
  const limit = options?.limit ?? MAX_RESULTS;
  const q = encodeURIComponent(query.trim().slice(0, 80));
  const url = `https://www.alibaba.com/trade/search?fsb=y&IndexArea=product_en&CatId=&SearchText=${q}`;

  const fetched = await fetchHtml(url, () => aliLimiter());
  if (!fetched.ok) {
    structuredLog({
      jobId: options?.jobId,
      source: "alibaba",
      errorType: fetched.errorType,
      message: fetched.message,
    });
    return {
      items: [],
      errors: [
        {
          message: `Alibaba: ${fetched.message}`,
          errorType: fetched.errorType,
        },
      ],
    };
  }

  const items = parseAlibabaHtml(fetched.html, limit);
  if (items.length === 0) {
    return {
      items: [],
      errors: [
        {
          message: "Alibaba: no products parsed (layout change or empty)",
          errorType: "parse_empty",
        },
      ],
    };
  }
  await sleep(200);
  return { items, errors: [] };
}
