import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
  clampNicheDescription,
  normalizeNicheKeywords,
  type NicheInput,
} from "./lib/nicheProfile";
import { normalizeProductName } from "./productMatch";
import { TOP_N } from "./limits";

const SITE_TO_GEO: Record<string, string> = {
  MLA: "AR",
  MLB: "BR",
  MLM: "MX",
  MLC: "CL",
  MCO: "CO",
};

const relatedQueryValidator = v.object({
  query: v.string(),
  kind: v.union(v.literal("rising"), v.literal("top")),
  /** Normalized 0–100 interest signal for scoring. */
  interest: v.number(),
  rawValue: v.optional(v.string()),
});

export type RelatedTrendQuery = {
  query: string;
  kind: "rising" | "top";
  interest: number;
  rawValue?: string;
};

export type NicheTrendsResult = {
  seedQuery: string;
  related: RelatedTrendQuery[];
  seedInterest: number;
  source: "serpapi" | "estimate" | "none";
};

/** One seed query from store niche (RELATED_QUERIES accepts a single q). */
export function buildNicheSeedQuery(input: NicheInput): string {
  const keywords = normalizeNicheKeywords(input.keywords);
  if (keywords.length > 0) {
    return keywords[0]!.slice(0, 40);
  }
  const description = clampNicheDescription(input.description);
  if (!description) return "";
  const words = normalizeProductName(description)
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 3);
  return words.join(" ").slice(0, 40);
}

function estimateInterest(keyword: string): number {
  const hash = [...keyword].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return 35 + (hash % 50);
}

function estimateRelated(seed: string): RelatedTrendQuery[] {
  const base = normalizeProductName(seed) || "trend";
  const stubs = [
    `${base} comprar`,
    `${base} precio`,
    `mejor ${base}`,
    `${base} oferta`,
    `${base} 2026`,
  ];
  return stubs.map((query, i) => ({
    query,
    kind: i < 2 ? ("rising" as const) : ("top" as const),
    interest: i < 2 ? 85 - i * 5 : 70 - i * 5,
    rawValue: "estimate",
  }));
}

function normalizeRisingInterest(extracted: number): number {
  if (extracted <= 100) return Math.max(55, extracted);
  const compressed = 55 + Math.log10(extracted) * 12;
  return Math.min(98, Math.round(compressed));
}

function normalizeTopInterest(extracted: number): number {
  if (Number.isNaN(extracted)) return 50;
  return Math.min(100, Math.max(0, Math.round(extracted)));
}

/**
 * Local interest for a product title from the niche Trends bundle (no extra API).
 */
export function interestFromNicheTrends(
  title: string,
  nicheTrends: NicheTrendsResult,
): number {
  const titleNorm = normalizeProductName(title);
  if (!titleNorm) return nicheTrends.seedInterest;

  let best = 0;
  for (const rel of nicheTrends.related) {
    const qNorm = normalizeProductName(rel.query);
    if (!qNorm || qNorm.length < 3) continue;
    const hit =
      titleNorm.includes(qNorm) ||
      qNorm.includes(titleNorm) ||
      tokenOverlap(titleNorm, qNorm) >= 0.4;
    if (hit) best = Math.max(best, rel.interest);
  }

  if (best > 0) return best;
  return nicheTrends.seedInterest;
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

/**
 * ONE SerpAPI call: RELATED_QUERIES for the niche seed.
 * Result is evidence for Gemini to cross with ML — not a sequential funnel step.
 */
export const fetchNicheTrends = internalAction({
  args: {
    siteId: v.string(),
    nicheKeywords: v.optional(v.array(v.string())),
    businessDescription: v.optional(v.string()),
  },
  returns: v.object({
    seedQuery: v.string(),
    related: v.array(relatedQueryValidator),
    seedInterest: v.number(),
    source: v.union(
      v.literal("serpapi"),
      v.literal("estimate"),
      v.literal("none"),
    ),
  }),
  handler: async (_ctx, args): Promise<NicheTrendsResult> => {
    const seedQuery = buildNicheSeedQuery({
      keywords: args.nicheKeywords,
      description: args.businessDescription,
    });

    if (!seedQuery) {
      return {
        seedQuery: "",
        related: [],
        seedInterest: 50,
        source: "none",
      };
    }

    const apiKey = process.env.SERPAPI_API_KEY;
    const geo = SITE_TO_GEO[args.siteId] ?? "AR";

    if (!apiKey) {
      const related = estimateRelated(seedQuery);
      return {
        seedQuery,
        related,
        seedInterest: estimateInterest(seedQuery),
        source: "estimate",
      };
    }

    const params = new URLSearchParams({
      engine: "google_trends",
      q: seedQuery,
      geo,
      data_type: "RELATED_QUERIES",
      api_key: apiKey,
    });

    try {
      const res = await fetch(`https://serpapi.com/search.json?${params}`);
      if (!res.ok) {
        console.error(
          "SerpAPI RELATED_QUERIES error",
          res.status,
          await res.text(),
        );
        const related = estimateRelated(seedQuery);
        return {
          seedQuery,
          related,
          seedInterest: estimateInterest(seedQuery),
          source: "estimate",
        };
      }

      const json = (await res.json()) as {
        error?: string;
        related_queries?: {
          rising?: Array<{
            query?: string;
            value?: string;
            extracted_value?: number;
          }>;
          top?: Array<{
            query?: string;
            value?: string;
            extracted_value?: number;
          }>;
        };
      };

      if (json.error) {
        console.error("SerpAPI RELATED_QUERIES payload error", json.error);
        const related = estimateRelated(seedQuery);
        return {
          seedQuery,
          related,
          seedInterest: estimateInterest(seedQuery),
          source: "estimate",
        };
      }

      const related: RelatedTrendQuery[] = [];

      for (const row of json.related_queries?.rising ?? []) {
        if (!row.query?.trim()) continue;
        related.push({
          query: row.query.trim(),
          kind: "rising",
          interest: normalizeRisingInterest(row.extracted_value ?? 0),
          rawValue: row.value,
        });
      }
      for (const row of json.related_queries?.top ?? []) {
        if (!row.query?.trim()) continue;
        related.push({
          query: row.query.trim(),
          kind: "top",
          interest: normalizeTopInterest(row.extracted_value ?? 50),
          rawValue: row.value,
        });
      }

      const byKey = new Map<string, RelatedTrendQuery>();
      for (const r of related) {
        const key = normalizeProductName(r.query);
        const prev = byKey.get(key);
        if (!prev || (prev.kind === "top" && r.kind === "rising")) {
          byKey.set(key, r);
        }
      }
      const deduped = [...byKey.values()]
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "rising" ? -1 : 1;
          return b.interest - a.interest;
        })
        .slice(0, TOP_N * 2);

      const topInterests = deduped
        .filter((r) => r.kind === "top")
        .map((r) => r.interest);
      const seedInterest =
        topInterests.length > 0
          ? Math.round(
              topInterests.reduce((a, b) => a + b, 0) / topInterests.length,
            )
          : estimateInterest(seedQuery);

      console.log(
        `[trends] niche seed="${seedQuery}" related=${deduped.length} source=serpapi seedInterest=${seedInterest}`,
      );

      if (deduped.length === 0) {
        return {
          seedQuery,
          related: estimateRelated(seedQuery),
          seedInterest,
          source: "estimate",
        };
      }

      return {
        seedQuery,
        related: deduped,
        seedInterest,
        source: "serpapi",
      };
    } catch (error) {
      console.error("SerpAPI RELATED_QUERIES failed", error);
      return {
        seedQuery,
        related: estimateRelated(seedQuery),
        seedInterest: estimateInterest(seedQuery),
        source: "estimate",
      };
    }
  },
});
