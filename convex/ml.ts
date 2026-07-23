import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { TOP_N } from "./limits";
import { bucketFromTrendIndex, type MlBucket } from "./scoring";

type HighlightItem = {
  id: string;
  position: number;
  type: "ITEM" | "PRODUCT" | "USER_PRODUCT";
};

type MlTrendKeyword = {
  keyword: string;
  url?: string;
};

type EnrichedItem = {
  mlId: string;
  mlType: "ITEM" | "PRODUCT" | "USER_PRODUCT";
  position: number;
  title: string;
  image?: string;
  price?: number;
  currency?: string;
  permalink?: string;
  soldQuantity?: number;
};

async function getAccessToken(): Promise<string | null> {
  const direct = process.env.MERCADOLIBRE_ACCESS_TOKEN;
  if (direct) return direct;

  const clientId = process.env.MERCADOLIBRE_CLIENT_ID;
  const clientSecret = process.env.MERCADOLIBRE_CLIENT_SECRET;
  const refreshToken = process.env.MERCADOLIBRE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error("ML token refresh failed", await res.text());
    return null;
  }
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

async function mlGet<T>(
  path: string,
  token: string,
): Promise<T | null> {
  const res = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`ML GET ${path} failed`, res.status, await res.text());
    return null;
  }
  return (await res.json()) as T;
}

export const fetchCategoryTrends = internalAction({
  args: {
    siteId: v.string(),
    mlCategoryId: v.string(),
  },
  returns: v.object({
    highlights: v.array(
      v.object({
        id: v.string(),
        position: v.number(),
        type: v.union(
          v.literal("ITEM"),
          v.literal("PRODUCT"),
          v.literal("USER_PRODUCT"),
        ),
      }),
    ),
    keywords: v.array(
      v.object({
        keyword: v.string(),
        bucket: v.union(
          v.literal("fastest_growing"),
          v.literal("most_wanted"),
          v.literal("rising"),
        ),
      }),
    ),
    enriched: v.array(
      v.object({
        mlId: v.string(),
        mlType: v.union(
          v.literal("ITEM"),
          v.literal("PRODUCT"),
          v.literal("USER_PRODUCT"),
        ),
        position: v.number(),
        title: v.string(),
        image: v.optional(v.string()),
        price: v.optional(v.number()),
        currency: v.optional(v.string()),
        permalink: v.optional(v.string()),
        soldQuantity: v.optional(v.number()),
      }),
    ),
    usedDemo: v.boolean(),
  }),
  handler: async (_ctx, args) => {
    const token = await getAccessToken();
    if (!token) {
      return buildDemoPayload(args.siteId, args.mlCategoryId);
    }

    const highlightsRes = await mlGet<{ content?: HighlightItem[] }>(
      `/highlights/${args.siteId}/category/${args.mlCategoryId}`,
      token,
    );
    const trendsRes = await mlGet<MlTrendKeyword[]>(
      `/trends/${args.siteId}/${args.mlCategoryId}`,
      token,
    );

    const highlights = (highlightsRes?.content ?? []).slice(0, TOP_N);
    const keywords = (trendsRes ?? []).slice(0, TOP_N).map((k, i) => ({
      keyword: k.keyword,
      bucket: bucketFromTrendIndex(i) as MlBucket,
    }));

    const enriched: EnrichedItem[] = [];
    for (const h of highlights) {
      const detail = await enrichHighlight(h, token, args.siteId);
      if (detail) enriched.push(detail);
    }

    if (enriched.length === 0 && keywords.length === 0) {
      return buildDemoPayload(args.siteId, args.mlCategoryId);
    }

    return {
      highlights,
      keywords,
      enriched,
      usedDemo: false,
    };
  },
});

async function enrichHighlight(
  h: HighlightItem,
  token: string,
  siteId: string,
): Promise<EnrichedItem | null> {
  if (h.type === "ITEM" || h.type === "USER_PRODUCT") {
    const item = await mlGet<{
      id: string;
      title?: string;
      price?: number;
      currency_id?: string;
      permalink?: string;
      thumbnail?: string;
      secure_thumbnail?: string;
      sold_quantity?: number;
    }>(`/items/${h.id}`, token);

    if (!item?.title) {
      return {
        mlId: h.id,
        mlType: h.type,
        position: h.position,
        title: `${siteId} item ${h.id}`,
      };
    }

    return {
      mlId: h.id,
      mlType: h.type,
      position: h.position,
      title: item.title,
      image: item.secure_thumbnail ?? item.thumbnail,
      price: item.price,
      currency: item.currency_id,
      permalink: item.permalink,
      soldQuantity: item.sold_quantity,
    };
  }

  const product = await mlGet<{
    id: string;
    name?: string;
    permalink?: string;
    buy_box_winner?: { price?: number; currency_id?: string };
    pictures?: Array<{ url?: string; secure_url?: string }>;
  }>(`/products/${h.id}`, token);

  if (!product?.name) {
    return {
      mlId: h.id,
      mlType: "PRODUCT",
      position: h.position,
      title: `${siteId} product ${h.id}`,
    };
  }

  return {
    mlId: h.id,
    mlType: "PRODUCT",
    position: h.position,
    title: product.name,
    image: product.pictures?.[0]?.secure_url ?? product.pictures?.[0]?.url,
    price: product.buy_box_winner?.price,
    currency: product.buy_box_winner?.currency_id,
    permalink: product.permalink,
  };
}

/**
 * Search ML catalog for a concrete product name (links niche web discoveries).
 * Returns null without token or when no good hit.
 */
export const searchProduct = internalAction({
  args: {
    siteId: v.string(),
    query: v.string(),
  },
  returns: v.union(
    v.object({
      mlId: v.string(),
      mlType: v.union(
        v.literal("ITEM"),
        v.literal("PRODUCT"),
        v.literal("USER_PRODUCT"),
      ),
      title: v.string(),
      image: v.optional(v.string()),
      price: v.optional(v.number()),
      currency: v.optional(v.string()),
      permalink: v.optional(v.string()),
      soldQuantity: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (_ctx, args) => {
    const token = await getAccessToken();
    if (!token) return null;

    const q = args.query.trim().slice(0, 80);
    if (q.length < 3) return null;

    const path = `/sites/${args.siteId}/search?q=${encodeURIComponent(q)}&limit=5`;
    const res = await mlGet<{
      results?: Array<{
        id?: string;
        title?: string;
        price?: number;
        currency_id?: string;
        permalink?: string;
        thumbnail?: string;
        secure_thumbnail?: string;
        sold_quantity?: number;
      }>;
    }>(path, token);

    const hit = res?.results?.find((r) => r.id && r.title);
    if (!hit?.id || !hit.title) return null;

    return {
      mlId: hit.id,
      mlType: "ITEM" as const,
      title: hit.title,
      image: hit.secure_thumbnail ?? hit.thumbnail,
      price: hit.price,
      currency: hit.currency_id,
      permalink: hit.permalink,
      soldQuantity: hit.sold_quantity,
    };
  },
});

function buildDemoPayload(siteId: string, mlCategoryId: string) {
  const demoProducts = [
    "Kit taladro percutor 750W",
    "Lámpara LED smart WiFi",
    "Auriculares bluetooth ANC",
    "Organizador modular cocina",
    "Sierra circular 1400W",
    "Crema facial vitamina C",
    "Mouse gamer RGB",
    "Set herramientas 108 piezas",
    "Cafetera espresso 20 bar",
    "Aspiradora robot lidar",
  ].slice(0, TOP_N);

  const enriched = demoProducts.map((title, i) => ({
    mlId: `${siteId}-DEMO-${mlCategoryId}-${i + 1}`,
    mlType: "ITEM" as const,
    position: i + 1,
    title,
    image: undefined,
    price: 15000 + i * 3200,
    currency: "ARS",
    permalink: `https://www.mercadolibre.com.ar/`,
    soldQuantity: 500 - i * 40,
  }));

  const keywords = [
    "taladro inalambrico",
    "lampara led",
    "auriculares bluetooth",
    "organizador cocina",
    "crema vitamina c",
    "mouse gamer",
    "set herramientas",
    "sierra circular",
    "cafetera espresso",
    "aspiradora robot",
  ]
    .slice(0, TOP_N)
    .map((keyword, i) => ({
      keyword,
      bucket: bucketFromTrendIndex(i) as MlBucket,
    }));

  return {
    highlights: enriched.map((e) => ({
      id: e.mlId,
      position: e.position,
      type: e.mlType,
    })),
    keywords,
    enriched,
    usedDemo: true,
  };
}
