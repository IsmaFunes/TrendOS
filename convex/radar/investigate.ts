/**
 * Investigate: on-demand per-ad research triggered by the "Investigar"
 * button on an ad's detail page.
 *
 * Pipeline: (1) find other Meta ads pushing the same product, weighted by
 * how long they've run and how credible the advertiser looks; (2) match the
 * product on MercadoLibre; (3) find suppliers in AR/China/Brazil; (4) blend
 * all of it into a 0–10 opportunity score plus a profit estimate. Results
 * are cached per (ad, user) in `radarAdInvestigations` — re-running is a
 * deliberate action, not implicit background work.
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { textSimilarity, tokenizeProductName } from "./normalize";
import { nicheRelevance } from "../lib/nicheProfile";
import { calculateMargin } from "./logistics";
import { getCurrentUserOrNull } from "../lib/auth";
import { createMercadoLibreProvider } from "./providers/mercadolibre";
import { resolveMercadoLibreAccessToken } from "./providers/mlAuth";
import { searchAlibaba, searchMadeInChina } from "./providers/chinaB2b";
import {
  researchSuppliersForProduct,
  type SupplierCandidate,
} from "./providers/geminiResearch";
import type { ExternalProduct } from "./contracts";
import {
  investigationClassificationValidator,
  investigationScoreBreakdownValidator,
  investigationStatusValidator,
  mlMatchResultValidator,
  profitEstimateValidator,
  similarAdResultValidator,
  supplierOfferValidator,
  type SupplierCountry,
} from "./validators";

const AR = "AR";
const INVESTIGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATE_AD_POOL = 250;
const SIMILAR_AD_SHORTLIST = 6;
/** Documented estimate (MercadoLibre "clásica" listing fee), not a live rate. */
const ESTIMATED_ML_PLATFORM_FEE_RATE = 0.13;
const GEMINI_FLASH_MODEL = "gemini-3.6-flash";

// ───────────────────────── pure helpers ─────────────────────────────
// Exported for unit tests; no Convex/Node deps.

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function activeDaysBetween(
  startedAt: number | undefined,
  lastSeenAt: number,
): number {
  if (!startedAt) return 0;
  return Math.max(
    0,
    Math.floor((lastSeenAt - startedAt) / (24 * 60 * 60 * 1000)),
  );
}

export function buildHeuristicProductSignal(
  pageName: string,
  body: string,
): { productName: string; searchQuery: string } {
  const tokens = tokenizeProductName(`${pageName} ${body}`);
  const core = tokens.slice(0, 8);
  const fallback = tokenizeProductName(pageName).join(" ");
  const searchQuery = core.join(" ").trim() || fallback || "producto";
  const productName = core.length
    ? core.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ")
    : pageName.trim() || "Producto";
  return { productName, searchQuery };
}

export function scoreStoreQuality(input: {
  hasStore: boolean;
  platform?: string;
  activeAdCount?: number;
  totalAdCount?: number;
  adActiveDays: number;
}): { score: number; label: string } {
  let score = 0.3;
  if (input.hasStore) score += 0.15;
  if (
    input.platform === "shopify" ||
    input.platform === "tiendanube" ||
    input.platform === "mercadolibre"
  ) {
    score += 0.15;
  }
  score += Math.min(0.25, ((input.activeAdCount ?? 0) / 20) * 0.25);
  score += Math.min(0.15, ((input.totalAdCount ?? 0) / 100) * 0.15);
  score += Math.min(0.2, (input.adActiveDays / 60) * 0.2);
  const clamped = clamp01(score);
  const label =
    clamped >= 0.7
      ? "Tienda consolidada"
      : clamped >= 0.45
        ? "Tienda activa"
        : "Señales limitadas";
  return { score: clamped, label };
}

export type SimilarAdCandidate = {
  adId: Id<"radarAds">;
  pageName: string;
  body: string;
  imageUrl?: string;
  videoUrl?: string;
  destinationUrl?: string;
  snapshotUrl?: string;
  activeDays: number;
  storeQualityScore: number;
  storeQualityLabel: string;
};

export type RankedSimilarAd = {
  adId: Id<"radarAds">;
  pageName: string;
  imageUrl?: string;
  videoUrl?: string;
  destinationUrl?: string;
  snapshotUrl?: string;
  activeDays: number;
  matchScore: number;
  storeQualityScore: number;
  storeQualityLabel: string;
};

/** Minimum text-similarity to count as "the same product" advertised elsewhere. */
const SIMILAR_AD_MIN_MATCH = 0.12;

export function rankSimilarAds(
  searchQuery: string,
  candidates: SimilarAdCandidate[],
  limit = 3,
): RankedSimilarAd[] {
  const scored = candidates
    .map((c) => {
      const matchScore = textSimilarity(searchQuery, `${c.pageName} ${c.body}`);
      const activeDaysNorm = clamp01(c.activeDays / 60);
      const combined =
        matchScore * 0.55 + activeDaysNorm * 0.25 + c.storeQualityScore * 0.2;
      return { c, matchScore, combined };
    })
    .filter((s) => s.matchScore >= SIMILAR_AD_MIN_MATCH)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, limit);

  return scored.map(({ c, matchScore }) => ({
    adId: c.adId,
    pageName: c.pageName,
    imageUrl: c.imageUrl,
    videoUrl: c.videoUrl,
    destinationUrl: c.destinationUrl,
    snapshotUrl: c.snapshotUrl,
    activeDays: c.activeDays,
    storeQualityScore: c.storeQualityScore,
    storeQualityLabel: c.storeQualityLabel,
    matchScore: Number(matchScore.toFixed(2)),
  }));
}

export type RankedMlMatch = {
  externalId: string;
  title: string;
  imageUrl?: string;
  permalink?: string;
  price?: number;
  currency?: string;
  soldQuantity?: number;
  condition?: string;
  sellerName?: string;
  matchScore: number;
  badge: "best_match" | "match" | "alternative";
};

export function rankMlMatches(
  searchQuery: string,
  items: ExternalProduct[],
  limit = 3,
): { matches: RankedMlMatch[]; warning?: string } {
  const scored = items
    .map((item) => ({
      item,
      matchScore: textSimilarity(searchQuery, item.title),
    }))
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return (b.item.soldQuantity ?? 0) - (a.item.soldQuantity ?? 0);
    })
    .slice(0, limit);

  if (scored.length === 0) {
    return {
      matches: [],
      warning:
        "No encontramos publicaciones en MercadoLibre para este producto.",
    };
  }

  const matches: RankedMlMatch[] = scored.map(({ item, matchScore }, index) => {
    const badge: RankedMlMatch["badge"] =
      index === 0 && matchScore >= 0.32
        ? "best_match"
        : matchScore >= 0.22
          ? "match"
          : "alternative";
    return {
      externalId: item.externalId,
      title: item.title,
      imageUrl: item.imageUrl,
      permalink: item.externalUrl,
      price: item.price,
      currency: item.currency,
      soldQuantity: item.soldQuantity,
      condition: item.condition,
      sellerName: item.sellerName,
      matchScore: Number(matchScore.toFixed(2)),
      badge,
    };
  });

  const warning =
    matches[0]!.badge !== "best_match"
      ? "Coincidencias débiles en MercadoLibre — confirmá manualmente antes de decidir."
      : undefined;

  return { matches, warning };
}

const SCORE_WEIGHTS = {
  adSignal: 0.25,
  mlSignal: 0.3,
  sourcingSignal: 0.3,
  nicheFit: 0.15,
} as const;

export type InvestigationScoreInputs = {
  targetActiveDays: number;
  targetStoreQuality: number;
  similarAdCount: number;
  bestMlMatchScore: number;
  bestMlSoldQuantity: number | undefined;
  mlMatchCount: number;
  suppliersFound: number;
  sourcingMargin: number | null;
  nicheFitScore: number;
};

export type InvestigationScoreResult = {
  score: number;
  classification: "strong" | "moderate" | "weak";
  breakdown: {
    adSignal: number;
    mlSignal: number;
    sourcingSignal: number;
    nicheFit: number;
  };
};

export function computeInvestigationScore(
  inputs: InvestigationScoreInputs,
): InvestigationScoreResult {
  const activeDaysNorm = clamp01(inputs.targetActiveDays / 60);
  const corroboration = Math.min(0.3, inputs.similarAdCount * 0.1);
  const adSignal = clamp01(
    (activeDaysNorm * 0.5 + inputs.targetStoreQuality * 0.5) * 0.7 +
      corroboration,
  );

  const demandFromSold =
    inputs.bestMlSoldQuantity != null
      ? clamp01(Math.log10(1 + inputs.bestMlSoldQuantity) / Math.log10(501))
      : 0;
  const mlSignal =
    inputs.mlMatchCount === 0
      ? 0.15
      : clamp01(
          inputs.bestMlMatchScore * 0.5 +
            demandFromSold * 0.35 +
            (inputs.mlMatchCount >= 2 ? 0.15 : 0),
        );

  const sourcingSignal =
    inputs.sourcingMargin != null
      ? clamp01(inputs.sourcingMargin / 0.5)
      : inputs.suppliersFound > 0
        ? 0.35
        : 0;

  const nicheFit = clamp01(inputs.nicheFitScore);

  const weighted =
    adSignal * SCORE_WEIGHTS.adSignal +
    mlSignal * SCORE_WEIGHTS.mlSignal +
    sourcingSignal * SCORE_WEIGHTS.sourcingSignal +
    nicheFit * SCORE_WEIGHTS.nicheFit;

  const score = Math.max(0, Math.min(10, Number((weighted * 10).toFixed(1))));
  const classification: InvestigationScoreResult["classification"] =
    score >= 6.5 ? "strong" : score >= 4 ? "moderate" : "weak";

  return {
    score,
    classification,
    breakdown: {
      adSignal: Number(adSignal.toFixed(2)),
      mlSignal: Number(mlSignal.toFixed(2)),
      sourcingSignal: Number(sourcingSignal.toFixed(2)),
      nicheFit: Number(nicheFit.toFixed(2)),
    },
  };
}

export type SupplierOffer = {
  supplierName?: string;
  country: SupplierCountry;
  isImport: boolean;
  unitPrice: number;
  currency: string;
  moq?: number;
  leadTimeDays?: number;
  url?: string;
  source: string;
};

export type ProfitEstimate = {
  bestSupplierPrice?: number;
  bestSupplierCurrency?: string;
  bestSupplierCountry?: SupplierCountry;
  estimatedSalePrice?: number;
  estimatedSaleCurrency?: string;
  estimatedProfit?: number;
  estimatedMargin?: number;
  platformFeeRate?: number;
  isEstimated: boolean;
  note?: string;
};

function convertToArs(
  price: number,
  currency: string,
  fxUsdArs?: number | null,
  fxBrlArs?: number | null,
): number | null {
  if (currency === "ARS") return price;
  if (currency === "USD" && fxUsdArs) return price * fxUsdArs;
  if (currency === "BRL" && fxBrlArs) return price * fxBrlArs;
  return null;
}

export function computeProfitEstimate(input: {
  suppliers: SupplierOffer[];
  estimatedSalePrice: number | null;
  fxUsdArs?: number | null;
  fxBrlArs?: number | null;
}): ProfitEstimate | undefined {
  if (input.suppliers.length === 0) return undefined;

  let best: { supplier: SupplierOffer; arsCost: number } | null = null;
  for (const s of input.suppliers) {
    const arsCost = convertToArs(
      s.unitPrice,
      s.currency,
      input.fxUsdArs,
      input.fxBrlArs,
    );
    if (arsCost == null) continue;
    if (!best || arsCost < best.arsCost) best = { supplier: s, arsCost };
  }

  if (!best) {
    const cheapest = [...input.suppliers].sort(
      (a, b) => a.unitPrice - b.unitPrice,
    )[0]!;
    return {
      bestSupplierPrice: cheapest.unitPrice,
      bestSupplierCurrency: cheapest.currency,
      bestSupplierCountry: cheapest.country,
      estimatedSalePrice: input.estimatedSalePrice ?? undefined,
      estimatedSaleCurrency: input.estimatedSalePrice != null ? "ARS" : undefined,
      isEstimated: true,
      note: "No pudimos convertir el costo a ARS (configurá TREND_RADAR_USD_ARS_RATE / TREND_RADAR_BRL_ARS_RATE) — margen no calculado.",
    };
  }

  if (input.estimatedSalePrice == null) {
    return {
      bestSupplierPrice: best.supplier.unitPrice,
      bestSupplierCurrency: best.supplier.currency,
      bestSupplierCountry: best.supplier.country,
      isEstimated: true,
      note: "Sin precio de referencia en MercadoLibre — no se pudo estimar margen.",
    };
  }

  const margin = calculateMargin({
    purchaseCost: best.arsCost,
    platformFee: input.estimatedSalePrice * ESTIMATED_ML_PLATFORM_FEE_RATE,
    estimatedSalePrice: input.estimatedSalePrice,
  });

  return {
    bestSupplierPrice: best.supplier.unitPrice,
    bestSupplierCurrency: best.supplier.currency,
    bestSupplierCountry: best.supplier.country,
    estimatedSalePrice: input.estimatedSalePrice,
    estimatedSaleCurrency: "ARS",
    estimatedProfit: margin.estimatedProfit ?? undefined,
    estimatedMargin: margin.estimatedMargin ?? undefined,
    platformFeeRate: ESTIMATED_ML_PLATFORM_FEE_RATE,
    isEstimated: true,
    note:
      best.supplier.country === "AR"
        ? "Estimado: no incluye flete local ni impuestos."
        : "Estimado con tipo de cambio configurado; no incluye flete de importación ni impuestos.",
  };
}

export function capSuppliersByCountry<
  T extends { country: SupplierCountry; unitPrice: number },
>(suppliers: T[], perCountry: number, total: number): T[] {
  const byCountry = new Map<string, T[]>();
  for (const s of suppliers) {
    const arr = byCountry.get(s.country) ?? [];
    arr.push(s);
    byCountry.set(s.country, arr);
  }
  const capped: T[] = [];
  for (const arr of byCountry.values()) {
    arr.sort((a, b) => a.unitPrice - b.unitPrice);
    capped.push(...arr.slice(0, perCountry));
  }
  capped.sort((a, b) => a.unitPrice - b.unitPrice);
  return capped.slice(0, total);
}

function numFromEnv(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ───────────────────── Gemini product-name refinement ─────────────────
// Local copy of the small generateContent caller (geminiAds.ts's version
// isn't exported and that file is "use node" for an unrelated reason).

async function callGeminiJsonLocal(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 512,
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

async function refineProductSignalWithGemini(
  pageName: string,
  body: string,
): Promise<{ productName: string; searchQuery: string } | null> {
  const prompt = `Extraé el nombre de producto físico concreto que se anuncia en este anuncio de Meta (Facebook/Instagram) de Argentina. Ignorá ganchos de oferta (envío gratis, cuotas, 2x1) y el nombre de la tienda.

Página: ${pageName}
Texto del anuncio: ${body.slice(0, 500)}

Respondé SOLO JSON: {"productName":"Nombre corto y concreto","searchQuery":"3 a 6 palabras para buscar en un marketplace"}`;
  const text = await callGeminiJsonLocal(prompt);
  const parsed = JSON.parse(text) as {
    productName?: unknown;
    searchQuery?: unknown;
  };
  const productName =
    typeof parsed.productName === "string"
      ? parsed.productName.trim().slice(0, 120)
      : "";
  const searchQuery =
    typeof parsed.searchQuery === "string"
      ? parsed.searchQuery.trim().slice(0, 80)
      : "";
  if (!productName || !searchQuery) return null;
  return { productName, searchQuery };
}

function isDisplayableCandidate(ad: {
  pageName: string;
  body?: string;
  mediaUrls: string[];
}): ad is { pageName: string; body: string; mediaUrls: string[] } {
  if (!ad.mediaUrls.some((u) => /^https?:\/\//i.test(u))) return false;
  const body = ad.body?.trim();
  if (!body || /\{\{\s*[\w.]+\s*\}\}/.test(body)) return false;
  if (!ad.pageName.trim() || ad.pageName === "Unknown page") return false;
  return true;
}

// ───────────────────────── Convex functions ────────────────────────────

const investigateContextValidator = v.union(
  v.null(),
  v.object({
    productName: v.string(),
    searchQuery: v.string(),
    ad: v.object({
      pageName: v.string(),
      body: v.string(),
      activeDays: v.number(),
      storeQualityScore: v.number(),
      storeQualityLabel: v.string(),
    }),
    profile: v.object({
      nicheKeywords: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
    }),
    similarAds: v.array(similarAdResultValidator),
  }),
);

export const loadInvestigateContext = internalQuery({
  args: { adId: v.id("radarAds"), userId: v.id("users") },
  returns: investigateContextValidator,
  handler: async (ctx, args) => {
    const ad = await ctx.db.get(args.adId);
    if (!ad || ad.country !== AR) return null;

    const [store, advertiser, profileDoc] = await Promise.all([
      ad.storeId ? ctx.db.get(ad.storeId) : Promise.resolve(null),
      ctx.db
        .query("radarAdvertisers")
        .withIndex("by_page", (q) => q.eq("pageId", ad.pageId))
        .unique(),
      ctx.db
        .query("businessProfiles")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .unique(),
    ]);

    const adActiveDays = activeDaysBetween(ad.startedAt, ad.lastSeenAt);
    const targetQuality = scoreStoreQuality({
      hasStore: Boolean(store),
      platform: store?.platform,
      activeAdCount: advertiser?.activeAdCount,
      totalAdCount: advertiser?.totalAdCount,
      adActiveDays,
    });

    const body = ad.body ?? "";
    const { productName, searchQuery } = buildHeuristicProductSignal(
      ad.pageName,
      body,
    );

    const pool = await ctx.db
      .query("radarAds")
      .withIndex("by_active_country", (q) =>
        q.eq("isActive", true).eq("country", AR),
      )
      .order("desc")
      .take(CANDIDATE_AD_POOL);

    const poolById = new Map(pool.map((c) => [c._id, c]));
    const prelim = pool
      .filter((c) => c._id !== ad._id && isDisplayableCandidate(c))
      .map((c) => ({
        adId: c._id,
        matchScore: textSimilarity(
          searchQuery,
          `${c.pageName} ${c.body ?? ""}`,
        ),
      }))
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, SIMILAR_AD_SHORTLIST);

    const shortlisted: SimilarAdCandidate[] = [];
    for (const { adId } of prelim) {
      const c = poolById.get(adId);
      if (!c) continue;
      const [cStore, cAdvertiser] = await Promise.all([
        c.storeId ? ctx.db.get(c.storeId) : Promise.resolve(null),
        ctx.db
          .query("radarAdvertisers")
          .withIndex("by_page", (q) => q.eq("pageId", c.pageId))
          .unique(),
      ]);
      const cActiveDays = activeDaysBetween(c.startedAt, c.lastSeenAt);
      const quality = scoreStoreQuality({
        hasStore: Boolean(cStore),
        platform: cStore?.platform,
        activeAdCount: cAdvertiser?.activeAdCount,
        totalAdCount: cAdvertiser?.totalAdCount,
        adActiveDays: cActiveDays,
      });
      shortlisted.push({
        adId: c._id,
        pageName: c.pageName,
        body: c.body ?? "",
        imageUrl: c.mediaUrls[0],
        videoUrl: c.videoUrl,
        destinationUrl: c.destinationUrl,
        snapshotUrl: c.snapshotUrl,
        activeDays: cActiveDays,
        storeQualityScore: quality.score,
        storeQualityLabel: quality.label,
      });
    }

    const similarAds = rankSimilarAds(searchQuery, shortlisted, 3);

    return {
      productName,
      searchQuery,
      ad: {
        pageName: ad.pageName,
        body,
        activeDays: adActiveDays,
        storeQualityScore: targetQuality.score,
        storeQualityLabel: targetQuality.label,
      },
      profile: {
        nicheKeywords: profileDoc?.nicheKeywords,
        description: profileDoc?.description,
      },
      similarAds,
    };
  },
});

export const saveInvestigation = internalMutation({
  args: {
    adId: v.id("radarAds"),
    userId: v.id("users"),
    productQuery: v.string(),
    status: investigationStatusValidator,
    errorMessage: v.optional(v.string()),
    score: v.number(),
    classification: investigationClassificationValidator,
    scoreBreakdown: investigationScoreBreakdownValidator,
    similarAds: v.array(similarAdResultValidator),
    mlMatches: v.array(mlMatchResultValidator),
    suppliers: v.array(supplierOfferValidator),
    profit: v.optional(profitEstimateValidator),
    warnings: v.array(v.string()),
  },
  returns: v.id("radarAdInvestigations"),
  handler: async (ctx, args) => {
    // Defense in depth: this mutation is internal-only (never a public
    // client entry point), but the score is still re-clamped before
    // persisting since it flows through several pure-function hops above.
    const score =
      Number.isFinite(args.score) && !Number.isNaN(args.score)
        ? Math.max(0, Math.min(10, args.score))
        : 0;
    const now = Date.now();
    const existing = await ctx.db
      .query("radarAdInvestigations")
      .withIndex("by_ad_user", (q) =>
        q.eq("adId", args.adId).eq("userId", args.userId),
      )
      .unique();
    const doc = { ...args, score, createdAt: now, expiresAt: now + INVESTIGATION_TTL_MS };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("radarAdInvestigations", doc);
  },
});

const investigationRowValidator = v.object({
  _id: v.id("radarAdInvestigations"),
  _creationTime: v.number(),
  adId: v.id("radarAds"),
  userId: v.id("users"),
  productQuery: v.string(),
  status: investigationStatusValidator,
  errorMessage: v.optional(v.string()),
  score: v.number(),
  classification: investigationClassificationValidator,
  scoreBreakdown: investigationScoreBreakdownValidator,
  similarAds: v.array(similarAdResultValidator),
  mlMatches: v.array(mlMatchResultValidator),
  suppliers: v.array(supplierOfferValidator),
  profit: v.optional(profitEstimateValidator),
  warnings: v.array(v.string()),
  createdAt: v.number(),
  expiresAt: v.number(),
});

/** Cached result for the current user + ad, if any (does not trigger a run). */
export const getMyInvestigation = query({
  args: { adId: v.id("radarAds") },
  returns: v.union(investigationRowValidator, v.null()),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    return await ctx.db
      .query("radarAdInvestigations")
      .withIndex("by_ad_user", (q) =>
        q.eq("adId", args.adId).eq("userId", user._id),
      )
      .unique();
  },
});

export const investigateAd = action({
  args: { adId: v.id("radarAds") },
  returns: v.object({
    status: v.union(v.literal("ready"), v.literal("error"), v.literal("no_user")),
    investigationId: v.optional(v.id("radarAdInvestigations")),
    errorMessage: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "ready" | "error" | "no_user";
    investigationId?: Id<"radarAdInvestigations">;
    errorMessage?: string;
  }> => {
    const me = await ctx.runQuery(api.users.me, {});
    if (!me) {
      return { status: "no_user" };
    }

    const context = await ctx.runQuery(
      internal.radar.investigate.loadInvestigateContext,
      { adId: args.adId, userId: me._id },
    );
    if (!context) {
      return { status: "error", errorMessage: "Anuncio no encontrado" };
    }

    const warnings: string[] = [];
    let productName = context.productName;
    let searchQuery = context.searchQuery;

    if (process.env.GEMINI_API_KEY?.trim()) {
      try {
        const refined = await refineProductSignalWithGemini(
          context.ad.pageName,
          context.ad.body,
        );
        if (refined) {
          productName = refined.productName;
          searchQuery = refined.searchQuery;
        }
      } catch {
        // Heuristic productName/searchQuery from the context query stays.
      }
    }

    let mlItems: ExternalProduct[] = [];
    try {
      let accessToken: string | undefined;
      try {
        accessToken = await resolveMercadoLibreAccessToken();
      } catch {
        accessToken = undefined;
      }
      const provider = createMercadoLibreProvider({ accessToken });
      const result = await provider.searchProducts!({
        query: searchQuery,
        country: AR,
        limit: 10,
      });
      mlItems = result.items;
      if (result.items.length === 0 && result.errors.length > 0) {
        warnings.push(`MercadoLibre: ${result.errors[0]!.message}`);
      }
    } catch (err) {
      warnings.push(
        `MercadoLibre: ${err instanceof Error ? err.message : "error de red"}`,
      );
    }
    const { matches: mlMatches, warning: mlWarning } = rankMlMatches(
      searchQuery,
      mlItems,
      3,
    );
    if (mlWarning) warnings.push(mlWarning);

    const geminiEnabled = Boolean(process.env.GEMINI_API_KEY?.trim());
    const [micResult, aliResult, geminiSuppliers] = await Promise.allSettled([
      searchMadeInChina(searchQuery, { limit: 2 }),
      searchAlibaba(searchQuery, { limit: 2 }),
      geminiEnabled
        ? researchSuppliersForProduct({
            productName,
            niche: (context.profile.nicheKeywords ?? []).join(", "),
          })
        : Promise.resolve<SupplierCandidate[]>([]),
    ]);

    const suppliers: SupplierOffer[] = [];
    if (micResult.status === "fulfilled") {
      for (const item of micResult.value.items) {
        if (item.price == null) continue;
        suppliers.push({
          supplierName: item.sellerName,
          country: "CN",
          isImport: true,
          unitPrice: item.price,
          currency: item.currency ?? "USD",
          moq: item.availableQuantity,
          url: item.externalUrl,
          source: "made_in_china",
        });
      }
    }
    if (aliResult.status === "fulfilled") {
      for (const item of aliResult.value.items) {
        if (item.price == null) continue;
        suppliers.push({
          supplierName: item.sellerName,
          country: "CN",
          isImport: true,
          unitPrice: item.price,
          currency: item.currency ?? "USD",
          moq: item.availableQuantity,
          url: item.externalUrl,
          source: "alibaba",
        });
      }
    }
    if (geminiSuppliers.status === "fulfilled") {
      for (const s of geminiSuppliers.value) {
        suppliers.push({
          supplierName: s.supplierName,
          country: s.country,
          isImport: s.country !== "AR",
          unitPrice: s.unitPrice,
          currency: s.currency,
          moq: s.moq,
          leadTimeDays: s.leadTimeDays,
          url: s.url,
          source: "gemini_research",
        });
      }
    } else if (geminiEnabled) {
      warnings.push("Gemini: no se pudieron buscar proveedores");
    }

    const suppliersFinal = capSuppliersByCountry(suppliers, 2, 6);
    if (suppliersFinal.length === 0) {
      warnings.push("No encontramos proveedores verificables para este producto.");
    }

    const bestMl = mlMatches[0];
    const estimatedSalePrice =
      bestMl && (bestMl.currency === "ARS" || bestMl.currency == null)
        ? bestMl.price ?? null
        : null;
    const profit = computeProfitEstimate({
      suppliers: suppliersFinal,
      estimatedSalePrice,
      fxUsdArs: numFromEnv("TREND_RADAR_USD_ARS_RATE"),
      fxBrlArs: numFromEnv("TREND_RADAR_BRL_ARS_RATE"),
    });

    const nicheFitScore = nicheRelevance(productName, {
      keywords: context.profile.nicheKeywords,
      description: context.profile.description,
    });

    const scoreResult = computeInvestigationScore({
      targetActiveDays: context.ad.activeDays,
      targetStoreQuality: context.ad.storeQualityScore,
      similarAdCount: context.similarAds.length,
      bestMlMatchScore: bestMl?.matchScore ?? 0,
      bestMlSoldQuantity: bestMl?.soldQuantity,
      mlMatchCount: mlMatches.length,
      suppliersFound: suppliersFinal.length,
      sourcingMargin: profit?.estimatedMargin ?? null,
      nicheFitScore,
    });

    const investigationId: Id<"radarAdInvestigations"> = await ctx.runMutation(
      internal.radar.investigate.saveInvestigation,
      {
        adId: args.adId,
        userId: me._id,
        productQuery: productName,
        status: "ready",
        score: scoreResult.score,
        classification: scoreResult.classification,
        scoreBreakdown: scoreResult.breakdown,
        similarAds: context.similarAds,
        mlMatches,
        suppliers: suppliersFinal,
        profit,
        warnings,
      },
    );

    return { status: "ready", investigationId };
  },
});
