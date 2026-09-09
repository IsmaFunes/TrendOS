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
import {
  detectBrandModel,
  stripNumericNoiseTokens,
  textSimilarity,
  tokenizeProductName,
} from "./normalize";
import { AUTO_MERGE_THRESHOLD, MANUAL_REVIEW_THRESHOLD } from "./matching";
import { nicheRelevance } from "../lib/nicheProfile";
import { flattenedGateTerms } from "./niches";
import { calculateMargin } from "./logistics";
import { getCurrentUserOrNull } from "../lib/auth";
import { searchMadeInChina } from "./providers/chinaB2b";
import { searchMercadoLibreViaShopping } from "./providers/serpapiShopping";
import { structuredLog } from "./http";
import {
  DOLAR_API_SOURCE_LABEL,
  fetchBlueDolarRate,
} from "./providers/dolarApi";
import {
  researchMercadoLibreListings,
  researchSuppliersForProduct,
  type MercadoLibreListingCandidate,
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
  type DataSource,
} from "./validators";

const INVESTIGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATE_AD_POOL = 250;
const SIMILAR_AD_SHORTLIST = 6;
/** Documented estimate (MercadoLibre "clásica" listing fee), not a live rate. */
const ESTIMATED_ML_PLATFORM_FEE_RATE = 0.13;
/** Documented estimate (typical Mercado Envíos seller-side cost for a light package), not a live rate. */
const ESTIMATED_SHIPPING_COST_RATE = 0.08;
/** Documented estimate (typical paid-social TACOS for an ecommerce store), not derived from any real campaign. */
const ESTIMATED_AD_SPEND_RATE = 0.15;
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
  const tokens = stripNumericNoiseTokens(
    tokenizeProductName(`${pageName} ${body}`),
  );
  const core = tokens.slice(0, 8);
  const fallback = stripNumericNoiseTokens(tokenizeProductName(pageName)).join(
    " ",
  );
  const searchQuery = core.join(" ").trim() || fallback || "producto";
  const productName = core.length
    ? core.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ")
    : pageName.trim() || "Producto";
  return { productName, searchQuery };
}

/** Facebook page likes above this are treated as "as credible as it gets" for the log-scaled bonus. */
const PAGE_LIKE_COUNT_CEILING = 50_000;
/** A deleted Facebook page caps the score regardless of every other signal — the store itself may be gone. */
const DELETED_PAGE_SCORE_CAP = 0.15;

export function scoreStoreQuality(input: {
  hasStore: boolean;
  platform?: string;
  activeAdCount?: number;
  totalAdCount?: number;
  adActiveDays: number;
  /** Facebook page follower count, straight from the Ad Library payload — real, not scrape-derived. */
  pageLikeCount?: number;
  /** True once Meta reports the page itself as deleted. */
  pageIsDeleted?: boolean;
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
  if (input.pageLikeCount != null && input.pageLikeCount > 0) {
    score +=
      clamp01(
        Math.log10(1 + input.pageLikeCount) /
          Math.log10(1 + PAGE_LIKE_COUNT_CEILING),
      ) * 0.2;
  }
  let clamped = clamp01(score);
  if (input.pageIsDeleted) {
    clamped = Math.min(clamped, DELETED_PAGE_SCORE_CAP);
  }
  const label = input.pageIsDeleted
    ? "Página de Facebook eliminada"
    : clamped >= 0.7
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

/**
 * Minimum text-similarity to count as "the same product" advertised
 * elsewhere — raised from an earlier 0.12, which let coincidental token
 * overlap (e.g. sharing one generic word) qualify as a match.
 */
const SIMILAR_AD_MIN_MATCH = 0.22;
/** Match-score gap within which store/activeDays may break a near-tie. */
const SIMILAR_AD_TIE_MARGIN = 0.05;

export function rankSimilarAds(
  searchQuery: string,
  candidates: SimilarAdCandidate[],
  limit = 3,
): RankedSimilarAd[] {
  const scored = candidates
    .map((c) => ({
      c,
      matchScore: textSimilarity(searchQuery, `${c.pageName} ${c.body}`),
    }))
    .filter((s) => s.matchScore >= SIMILAR_AD_MIN_MATCH)
    .sort((a, b) => {
      // A better product match always wins — store credibility and ad
      // longevity only decide between two candidates that are already
      // close matches, they can never promote a weaker match over a
      // stronger one.
      if (Math.abs(b.matchScore - a.matchScore) > SIMILAR_AD_TIE_MARGIN) {
        return b.matchScore - a.matchScore;
      }
      const tieBreak = (s: SimilarAdCandidate) =>
        clamp01(s.activeDays / 60) * 0.5 + s.storeQualityScore * 0.5;
      return tieBreak(b.c) - tieBreak(a.c);
    })
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
  /** "mercadolibre" = official API; "gemini_research" = web-search fallback. */
  source: DataSource;
};

/**
 * Score a candidate ML listing against the search query the same way
 * matching.ts's catalog matcher scores a listing against a known product:
 * brand+model agreement outranks raw text similarity, since two products in
 * the same category can share most of their words without being the same
 * SKU (e.g. two thermos ads). Kept in sync with matching.ts's thresholds
 * (AUTO_MERGE_THRESHOLD / MANUAL_REVIEW_THRESHOLD) so "confident enough to
 * show as a match" means the same thing everywhere in the app.
 */
function scoreMlCandidate(searchQuery: string, item: ExternalProduct): number {
  const textScore = textSimilarity(searchQuery, item.title);
  const queryBrandModel = detectBrandModel(searchQuery);
  const itemBrandModel = detectBrandModel(item.title);
  const brand = (item.brand ?? itemBrandModel.brand)?.toLowerCase();
  const model = (item.model ?? itemBrandModel.model)?.toLowerCase();
  const queryBrand = queryBrandModel.brand?.toLowerCase();
  const queryModel = queryBrandModel.model?.toLowerCase();
  if (brand && model && brand === queryBrand && model === queryModel) {
    return Math.max(textScore, 0.9);
  }
  return textScore;
}

export function rankMlMatches(
  searchQuery: string,
  items: ExternalProduct[],
  limit = 3,
): { matches: RankedMlMatch[]; warning?: string } {
  const scored = items
    .map((item) => ({
      item,
      matchScore: scoreMlCandidate(searchQuery, item),
    }))
    // A low-similarity item isn't a real "alternative" — it's noise. Only
    // candidates a human would recognize as at least plausibly the same
    // product get surfaced at all (mirrors matching.ts's MANUAL_REVIEW_THRESHOLD).
    .filter(({ matchScore }) => matchScore >= MANUAL_REVIEW_THRESHOLD)
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
      index === 0 && matchScore >= AUTO_MERGE_THRESHOLD
        ? "best_match"
        : matchScore >= AUTO_MERGE_THRESHOLD
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
      source: item.source,
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
      ? 0
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
  /** The specific product title the offer is for — lets users verify relevance. */
  title: string;
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

/** Minimum title-vs-query similarity to keep a supplier offer. */
const SUPPLIER_MIN_MATCH = 0.12;

/**
 * Cheap defense against unrelated supplier results (a China B2B scrape or
 * an LLM search returning something in the same general category but not
 * the actual product) — drop anything whose real title doesn't overlap
 * with what we're actually sourcing.
 */
export function isRelevantSupplierTitle(
  referenceQuery: string,
  title: string,
): boolean {
  return textSimilarity(referenceQuery, title) >= SUPPLIER_MIN_MATCH;
}

export type ProfitEstimate = {
  bestSupplierPrice?: number;
  bestSupplierCurrency?: string;
  bestSupplierCountry?: SupplierCountry;
  estimatedSalePrice?: number;
  estimatedSaleCurrency?: string;
  estimatedShippingCost?: number;
  estimatedAdSpend?: number;
  estimatedProfit?: number;
  estimatedMargin?: number;
  platformFeeRate?: number;
  shippingCostRate?: number;
  adSpendRate?: number;
  fxRateUsed?: number;
  fxRateSource?: string;
  isEstimated: boolean;
  note?: string;
};

type FxRate = { rate: number; source: string } | null;

function convertToArs(
  price: number,
  currency: string,
  fxUsdArs?: FxRate,
  fxBrlArs?: FxRate,
): { arsCost: number; fx: FxRate } | null {
  if (currency === "ARS") return { arsCost: price, fx: null };
  if (currency === "USD" && fxUsdArs) {
    return { arsCost: price * fxUsdArs.rate, fx: fxUsdArs };
  }
  if (currency === "BRL" && fxBrlArs) {
    return { arsCost: price * fxBrlArs.rate, fx: fxBrlArs };
  }
  return null;
}

export function computeProfitEstimate(input: {
  suppliers: SupplierOffer[];
  estimatedSalePrice: number | null;
  fxUsdArs?: FxRate;
  fxBrlArs?: FxRate;
}): ProfitEstimate | undefined {
  if (input.suppliers.length === 0) return undefined;

  let best: { supplier: SupplierOffer; arsCost: number; fx: FxRate } | null = null;
  for (const s of input.suppliers) {
    const converted = convertToArs(
      s.unitPrice,
      s.currency,
      input.fxUsdArs,
      input.fxBrlArs,
    );
    if (converted == null) continue;
    if (!best || converted.arsCost < best.arsCost) {
      best = { supplier: s, arsCost: converted.arsCost, fx: converted.fx };
    }
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
      note: "No pudimos obtener un tipo de cambio para convertir el costo a ARS — margen no calculado.",
    };
  }

  if (input.estimatedSalePrice == null) {
    return {
      bestSupplierPrice: best.supplier.unitPrice,
      bestSupplierCurrency: best.supplier.currency,
      bestSupplierCountry: best.supplier.country,
      fxRateUsed: best.fx?.rate,
      fxRateSource: best.fx?.source,
      isEstimated: true,
      note: "Sin precio de referencia en MercadoLibre — no se pudo estimar margen.",
    };
  }

  const estimatedShippingCost =
    input.estimatedSalePrice * ESTIMATED_SHIPPING_COST_RATE;
  const estimatedAdSpend = input.estimatedSalePrice * ESTIMATED_AD_SPEND_RATE;
  const margin = calculateMargin({
    purchaseCost: best.arsCost,
    shippingCost: estimatedShippingCost,
    platformFee: input.estimatedSalePrice * ESTIMATED_ML_PLATFORM_FEE_RATE,
    adSpend: estimatedAdSpend,
    estimatedSalePrice: input.estimatedSalePrice,
  });

  return {
    bestSupplierPrice: best.supplier.unitPrice,
    bestSupplierCurrency: best.supplier.currency,
    bestSupplierCountry: best.supplier.country,
    estimatedSalePrice: input.estimatedSalePrice,
    estimatedSaleCurrency: "ARS",
    estimatedShippingCost,
    estimatedAdSpend,
    estimatedProfit: margin.estimatedProfit ?? undefined,
    estimatedMargin: margin.estimatedMargin ?? undefined,
    platformFeeRate: ESTIMATED_ML_PLATFORM_FEE_RATE,
    shippingCostRate: ESTIMATED_SHIPPING_COST_RATE,
    adSpendRate: ESTIMATED_AD_SPEND_RATE,
    fxRateUsed: best.fx?.rate,
    fxRateSource: best.fx?.source,
    isEstimated: true,
    note:
      best.supplier.country === "AR"
        ? "Estimado: envío, comisión y ads son estimaciones genéricas, no de tu cuenta real. No incluye impuestos."
        : "Estimado con el tipo de cambio indicado; envío, comisión y ads son estimaciones genéricas, no de tu cuenta real. No incluye impuestos de importación.",
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

type GeminiInlineImage = { mimeType: string; data: string };

/** Fits Gemini's inline-image limit with headroom; larger creatives are skipped rather than rejected outright. */
const MAX_INLINE_IMAGE_BYTES = 6_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 6_000;
/**
 * Meta's SD ad video is usually a few MB for a short clip, but keep well
 * under Gemini's combined inline-request ceiling (~20MB) since it shares
 * the request with the prompt and any images — skip rather than truncate.
 */
const MAX_INLINE_VIDEO_BYTES = 15_000_000;
const VIDEO_FETCH_TIMEOUT_MS = 15_000;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Best-effort: a slow/broken image host shouldn't block product extraction, so failures resolve to null rather than throwing. */
export async function fetchImageInlineData(url: string): Promise<GeminiInlineImage | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!mimeType.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_INLINE_IMAGE_BYTES) return null;
    return { mimeType, data: arrayBufferToBase64(buf) };
  } catch {
    return null;
  }
}

/**
 * Many ads put the actual product identification (voiceover, on-screen
 * demo, size/material shown in use) in the video rather than the caption —
 * text+image extraction alone guesses blind in that case. Best-effort like
 * the image fetcher: a slow/broken/oversized video shouldn't block
 * extraction, it just falls back to text+images only.
 */
export async function fetchVideoInlineData(url: string): Promise<GeminiInlineImage | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!mimeType.startsWith("video/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_INLINE_VIDEO_BYTES) return null;
    return { mimeType, data: arrayBufferToBase64(buf) };
  } catch {
    return null;
  }
}

/**
 * Video is much heavier than the two images this call previously ever sent —
 * give it real headroom instead of the caller waiting on a fetch that has
 * no timeout at all (an unbounded hang here would stall the whole
 * automatic per-niche matching batch, not just one interactive click).
 */
const EXTRACT_SIGNAL_TIMEOUT_MS = 30_000;

async function callGeminiJsonLocal(
  prompt: string,
  images: GeminiInlineImage[] = [],
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const parts: Array<Record<string, unknown>> = [
    ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
    { text: prompt },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_SIGNAL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json",
            // gemini-3.6-flash is a thinking model — its reasoning tokens come
            // out of this same budget. 512 was silently starving the actual
            // answer: the model spent the whole budget "thinking" about the
            // classification + multi-field extraction task and got cut off
            // (finishReason MAX_TOKENS) before ever emitting JSON, leaving a
            // stray thought fragment that failed to parse — every extraction
            // silently fell back to the low-quality heuristic. thinkingLevel
            // "low" plus headroom fixes it (confirmed: STOP with ~100 answer
            // tokens instead of MAX_TOKENS with ~500 thinking tokens).
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    }>;
  };
  const finishReason = json.candidates?.[0]?.finishReason;
  const parts2 = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts2
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (finishReason === "MAX_TOKENS") {
    throw new Error("Gemini response truncated (MAX_TOKENS) before completion");
  }
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

export type ExtractedProductSignal = {
  isPhysicalProduct: boolean;
  /** Why it isn't, when isPhysicalProduct is false — for the user-facing message. */
  notAProductReason?: string;
  productName: string;
  category?: string;
  /** Distinctive descriptors (material, type, use case, size...) used to build tighter search queries. */
  attributes: string[];
  searchQuery: string;
  englishQuery: string;
};

/**
 * "We have the ad — now, what's the product?" This is the actual matching
 * gap: extracting a good enough signal to search *for*. A short noun-phrase
 * pulled from ad copy isn't enough — it also has to first tell physical
 * products (importable/resellable) apart from apps, courses, coaching
 * programs, and other services, which superficially share fitness/product
 * vocabulary but have nothing to match on MercadoLibre or with a supplier.
 */
function buildExtractProductSignalPrompt(
  pageName: string,
  body: string,
  hasImages: boolean,
  hasVideo: boolean,
): string {
  return `Analizá este anuncio de Meta (Facebook/Instagram) de Argentina.

Página: ${pageName}
Texto del anuncio: ${body.slice(0, 500)}
${
    hasImages
      ? "\nTambién se adjuntan una o más imágenes reales del anuncio — usalas junto con el texto para identificar el producto exacto (marca, tipo, variante, material) que se ve en la foto, sobre todo si el texto es un gancho de marketing genérico que no lo nombra con claridad.\n"
      : ""
  }${
    hasVideo
      ? "\nTambién se adjunta el video real del anuncio — en muchos anuncios el producto solo se identifica ahí (voz en off, demostración en uso, texto en pantalla, tamaño/material que se ve al usarlo), aunque el texto y las imágenes sean genéricos. Priorizá lo que se ve/escucha en el video si contradice o completa lo que dice el texto.\n"
      : ""
  }
Paso 1: ¿Promociona un PRODUCTO FÍSICO concreto — un objeto tangible que se pueda importar y revender? ¿O es otra cosa: app, curso online, programa de entrenamiento/coaching, servicio, suscripción, evento, inmueble, franquicia, contenido digital?

Si NO es un producto físico: isPhysicalProduct=false y explicá brevemente qué es en su lugar (ej. "programa de entrenamiento online", "app móvil").

Si SÍ es un producto físico:
- productName: descripción concreta y genérica del producto (tipo + material/variante), NO la categoría demasiado amplia ni el nombre de la tienda NI un nombre de línea/producto inventado por el vendedor (ej. "Difusor Atenea" → "difusor de aromas con varillas de caña" — el nombre propio "Atenea" es exclusivo de esa tienda y nadie más lo va a listar así en MercadoLibre o con un proveedor).
- category: rubro corto (ej. "fitness", "cocina", "mates").
- attributes: 2-4 palabras distintivas reales del producto (material, tamaño, uso, color) mencionadas o claramente implícitas, o visibles en la imagen — NO ganchos de oferta ni nombres de marca/línea propios.
- searchQuery: 2-4 palabras CORTAS y genéricas en español para buscarlo en un marketplace — el término más común que usaría cualquier comprador o vendedor de ese tipo de producto (tipo + máximo 1 atributo clave). NO apiles todos los attributes juntos: sumar material + tamaño + variante en la misma búsqueda reduce drásticamente los resultados en buscadores por palabra clave. Ej: para un difusor de aromas de vidrio con tapa de madera y varillas, searchQuery="difusor aromatizador ambiente" (no "difusor de aromas de vidrio con tapa de madera y varillas").
- englishQuery: la misma lógica en inglés (corta, genérica), para mayoristas B2B como Made-in-China.

Respondé SOLO JSON:
{"isPhysicalProduct":true,"notAProductReason":"","productName":"...","category":"...","attributes":["...","..."],"searchQuery":"...","englishQuery":"..."}`;
}

/** Pure JSON parsing, exported for unit tests — no network calls. */
export function parseExtractedProductSignal(text: string): ExtractedProductSignal | null {
  let parsed: {
    isPhysicalProduct?: unknown;
    notAProductReason?: unknown;
    productName?: unknown;
    category?: unknown;
    attributes?: unknown;
    searchQuery?: unknown;
    englishQuery?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }

  if (parsed.isPhysicalProduct === false) {
    const notAProductReason =
      typeof parsed.notAProductReason === "string" && parsed.notAProductReason.trim()
        ? parsed.notAProductReason.trim().slice(0, 160)
        : "no parece ser un producto físico";
    return {
      isPhysicalProduct: false,
      notAProductReason,
      productName: "",
      attributes: [],
      searchQuery: "",
      englishQuery: "",
    };
  }

  const productName =
    typeof parsed.productName === "string"
      ? parsed.productName.trim().slice(0, 120)
      : "";
  const searchQuery =
    typeof parsed.searchQuery === "string"
      ? parsed.searchQuery.trim().slice(0, 80)
      : "";
  const englishQuery =
    typeof parsed.englishQuery === "string"
      ? parsed.englishQuery.trim().slice(0, 80)
      : "";
  const category =
    typeof parsed.category === "string" ? parsed.category.trim().slice(0, 60) : undefined;
  const attributes = Array.isArray(parsed.attributes)
    ? parsed.attributes
        .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
        .map((a) => a.trim().slice(0, 40))
        .slice(0, 4)
    : [];
  if (!productName || !searchQuery) return null;
  return {
    isPhysicalProduct: true,
    productName,
    category,
    attributes,
    searchQuery,
    englishQuery: englishQuery || searchQuery,
  };
}

/** How many ad creatives to hand Gemini for product identification — first image is usually the hero shot; more adds latency to an interactive click for diminishing return. */
const MAX_EXTRACT_IMAGES = 2;

export async function extractProductSignalWithGemini(
  pageName: string,
  body: string,
  mediaUrls: string[] = [],
  videoUrl?: string,
): Promise<ExtractedProductSignal | null> {
  const [images, video] = await Promise.all([
    Promise.all(mediaUrls.slice(0, MAX_EXTRACT_IMAGES).map(fetchImageInlineData)).then(
      (results) => results.filter((img): img is GeminiInlineImage => img != null),
    ),
    videoUrl ? fetchVideoInlineData(videoUrl) : Promise.resolve(null),
  ]);
  const media = video ? [...images, video] : images;
  const prompt = buildExtractProductSignalPrompt(
    pageName,
    body,
    images.length > 0,
    video != null,
  );
  try {
    return parseExtractedProductSignal(await callGeminiJsonLocal(prompt, media));
  } catch {
    // Single retry, no backoff — this backs an interactive click with a
    // request timeout budget, not a batch job. A transient network blip
    // or 429 shouldn't force the low-quality heuristic fallback if a
    // second attempt would succeed.
    try {
      return parseExtractedProductSignal(await callGeminiJsonLocal(prompt, media));
    } catch (err) {
      structuredLog({
        source: "gemini_extract_signal",
        errorType: "extraction_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/**
 * Text-similarity alone can't tell "same product" from "same category" —
 * two thermos ads share plenty of tokens without being the same SKU. This
 * asks Gemini to judge the shortlist directly. Returns null (verification
 * skipped, caller keeps the heuristic order) only on outright failure —
 * an explicit empty `keep` list is trusted and returned as-is.
 */
async function verifySimilarAdsWithGemini(
  productName: string,
  candidates: Array<{ adId: string; pageName: string; bodySnippet: string }>,
): Promise<Set<string> | null> {
  const prompt = `Sos un curador estricto. Estamos investigando este producto: "${productName}".

Candidatos — otros anuncios de Meta que podrían estar promocionando el MISMO producto:
${JSON.stringify(
  candidates.map((c) => ({ id: c.adId, pagina: c.pageName, texto: c.bodySnippet })),
)}

Para cada candidato, decidí si es genuinamente EL MISMO producto físico (no solo la misma categoría o rubro — ej. "termo acero 1L" y "termo acero 750ml" NO son el mismo producto). DESCARTÁ también cualquier candidato que sea una app, curso online, programa de entrenamiento/coaching, servicio o suscripción en vez de un producto físico. Ante la duda, DESCARTALO.

Respondé SOLO JSON: {"keep":["id1","id2"]}`;
  try {
    const text = await callGeminiJsonLocal(prompt);
    const parsed = JSON.parse(text) as { keep?: unknown };
    if (!Array.isArray(parsed.keep)) return null;
    const validIds = new Set(candidates.map((c) => c.adId));
    const kept = parsed.keep.filter(
      (id): id is string => typeof id === "string" && validIds.has(id),
    );
    return new Set(kept);
  } catch {
    return null;
  }
}

const VERIFY_TIMEOUT_MS = 8_000;
/** Fraction of the claimed title's meaningful tokens that must actually appear on the page. */
const VERIFY_MIN_TOKEN_OVERLAP = 0.4;
const VERIFY_USER_AGENT =
  "Mozilla/5.0 (compatible; TrendOSVerify/1.0; +https://github.com/local)";
const DEAD_PAGE_MARKERS = [
  "página no encontrada",
  "publicación pausada",
  "ya no está disponible",
  "page not found",
];

/**
 * Gemini's "don't invent a URL" instruction is a request, not a guarantee —
 * grounded search can still misattribute a real-looking URL to the wrong
 * content (confirmed: a fitness-mat search once returned a genuine
 * mercadolibre.com.ar URL whose actual page was an unrelated decorative
 * Santa Claus figure). This is the only real check: fetch the page and
 * confirm the claimed title's words are actually there.
 */
export async function verifyUrlContent(
  url: string,
  claimedTitle: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": VERIFY_USER_AGENT },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return false;
    const html = (await res.text()).toLowerCase();
    if (DEAD_PAGE_MARKERS.some((marker) => html.includes(marker))) {
      return false;
    }
    const tokens = tokenizeProductName(claimedTitle);
    if (tokens.length === 0) return true;
    const hits = tokens.filter((t) => html.includes(t)).length;
    return hits / tokens.length >= VERIFY_MIN_TOKEN_OVERLAP;
  } catch {
    return false;
  }
}

async function verifyAll<T extends { url: string; title: string }>(
  candidates: T[],
): Promise<T[]> {
  const flags = await Promise.all(
    candidates.map((c) => verifyUrlContent(c.url, c.title).catch(() => false)),
  );
  return candidates.filter((_c, i) => flags[i]);
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

/**
 * Candidates returned for verification carry a body snippet the pure
 * similarAdResultValidator doesn't (that shape is what actually gets
 * persisted) — the action strips it after the optional Gemini pass.
 */
const contextSimilarAdValidator = similarAdResultValidator.extend({
  bodySnippet: v.string(),
});

/** How many ranked candidates to hand to Gemini verification before the final cut to 3. */
const SIMILAR_AD_VERIFICATION_POOL = 5;

const investigateContextValidator = v.union(
  v.null(),
  v.object({
    ad: v.object({
      activeDays: v.number(),
      storeQualityScore: v.number(),
      storeQualityLabel: v.string(),
    }),
    profile: v.object({
      nicheKeywords: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
    }),
    similarAds: v.array(contextSimilarAdValidator),
  }),
);

export const loadInvestigateContext = internalQuery({
  args: {
    adId: v.id("radarAds"),
    userId: v.id("users"),
    /** Best available product signal — Gemini-refined when possible, resolved by the caller before this query runs. */
    searchQuery: v.string(),
  },
  returns: investigateContextValidator,
  handler: async (ctx, args) => {
    const ad = await ctx.db.get(args.adId);
    if (!ad) return null;

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

    // The store's niche is now a fixed catalog entry rather than typed
    // keywords — flatten the curated gate terms of every niche the store
    // follows into the same "nicheKeywords" shape the prompts below expect.
    const nicheKeywords: string[] = [];
    if (profileDoc) {
      for (const nicheId of profileDoc.nicheIds) {
        const niche = await ctx.db.get(nicheId);
        if (niche) nicheKeywords.push(...flattenedGateTerms(niche));
      }
    }

    const adActiveDays = activeDaysBetween(ad.startedAt, ad.lastSeenAt);
    const targetQuality = scoreStoreQuality({
      hasStore: Boolean(store),
      platform: store?.platform,
      activeAdCount: advertiser?.activeAdCount,
      totalAdCount: advertiser?.totalAdCount,
      adActiveDays,
      pageLikeCount: advertiser?.pageLikeCount,
      pageIsDeleted: advertiser?.pageIsDeleted,
    });

    // Not AR-only anymore — ads are scraped across several countries, and a
    // similar ad from a different country is still a useful comparable.
    const pool = await ctx.db
      .query("radarAds")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .order("desc")
      .take(CANDIDATE_AD_POOL);

    const poolById = new Map(pool.map((c) => [c._id, c]));
    const prelim = pool
      .filter((c) => c._id !== ad._id && isDisplayableCandidate(c))
      .map((c) => ({
        adId: c._id,
        matchScore: textSimilarity(
          args.searchQuery,
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
        pageLikeCount: cAdvertiser?.pageLikeCount,
        pageIsDeleted: cAdvertiser?.pageIsDeleted,
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

    const bodyById = new Map(shortlisted.map((s) => [s.adId, s.body]));
    const similarAds = rankSimilarAds(
      args.searchQuery,
      shortlisted,
      SIMILAR_AD_VERIFICATION_POOL,
    ).map((sa) => ({
      ...sa,
      bodySnippet: (bodyById.get(sa.adId) ?? "").slice(0, 200),
    }));

    return {
      ad: {
        activeDays: adActiveDays,
        storeQualityScore: targetQuality.score,
        storeQualityLabel: targetQuality.label,
      },
      profile: {
        nicheKeywords: nicheKeywords.length ? nicheKeywords : undefined,
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

    const adBasic = await ctx.runQuery(api.radar.metaAds.getAd, {
      adId: args.adId,
    });
    if (!adBasic) {
      return { status: "error", errorMessage: "Anuncio no encontrado" };
    }

    const warnings: string[] = [];
    const geminiEnabled = Boolean(process.env.GEMINI_API_KEY?.trim());
    const heuristic = buildHeuristicProductSignal(
      adBasic.pageName,
      adBasic.body ?? "",
    );
    let productName = heuristic.productName;
    let searchQuery = heuristic.searchQuery;
    // English search phrase for China B2B sites (Made-in-China is
    // English-first — searching it in Spanish returns near-random noise).
    // Falls back to the Spanish query when Gemini isn't available/fails.
    let englishQuery = heuristic.searchQuery;

    if (geminiEnabled) {
      try {
        const extracted = await extractProductSignalWithGemini(
          adBasic.pageName,
          adBasic.body ?? "",
          adBasic.mediaUrls,
          adBasic.videoUrl,
        );
        if (extracted && !extracted.isPhysicalProduct) {
          // "We have the ad — what's the product?" Sometimes there isn't
          // one: an app, a coaching program, a course. Forcing a search
          // anyway is exactly how you get a fitness "product" investigation
          // turning up training-program ads and nonsense ML/supplier
          // matches — better to say so and stop here.
          const investigationId: Id<"radarAdInvestigations"> =
            await ctx.runMutation(internal.radar.investigate.saveInvestigation, {
              adId: args.adId,
              userId: me._id,
              productQuery: adBasic.pageName,
              status: "ready",
              score: 0,
              classification: "weak",
              scoreBreakdown: { adSignal: 0, mlSignal: 0, sourcingSignal: 0, nicheFit: 0 },
              similarAds: [],
              mlMatches: [],
              suppliers: [],
              profit: undefined,
              warnings: [
                `Este anuncio no parece promocionar un producto físico (${extracted.notAProductReason ?? "parece un servicio o app"}) — Investigar busca productos importables/revendibles.`,
              ],
            });
          return { status: "ready", investigationId };
        }
        if (extracted?.isPhysicalProduct) {
          productName = extracted.productName;
          searchQuery = extracted.searchQuery;
          englishQuery = extracted.englishQuery;
        }
      } catch {
        // Heuristic productName/searchQuery stays.
      }
    }

    // Candidate matching (similar Meta ads) uses whichever signal is best
    // by this point — Gemini-refined when available, heuristic otherwise —
    // so it's never stuck comparing against noisy raw ad-copy tokens.
    const context = await ctx.runQuery(
      internal.radar.investigate.loadInvestigateContext,
      { adId: args.adId, userId: me._id, searchQuery },
    );
    if (!context) {
      return { status: "error", errorMessage: "Anuncio no encontrado" };
    }

    // Mercado Libre's official search API is a dead end for unverified
    // third-party apps (policy 403 regardless of credentials) — real web
    // search replaces it entirely: SerpAPI's Google Shopping index for
    // structured, hallucination-free prices, and Gemini's Google-Search
    // grounding for real listing permalinks. Neither requires our server
    // to fetch mercadolibre.com.ar directly (which bot-gates anonymous
    // requests behind an account-verification challenge).
    const mlItems: ExternalProduct[] = [];
    const [shoppingResult, geminiListingsResult] = await Promise.allSettled([
      searchMercadoLibreViaShopping(searchQuery, { limit: 10 }),
      geminiEnabled
        ? researchMercadoLibreListings({ productName })
        : Promise.resolve<MercadoLibreListingCandidate[]>([]),
    ]);

    if (shoppingResult.status === "fulfilled") {
      mlItems.push(...shoppingResult.value.items);
      if (shoppingResult.value.items.length === 0 && shoppingResult.value.errors.length > 0) {
        warnings.push(
          `MercadoLibre (Google Shopping): ${shoppingResult.value.errors[0]!.message}`,
        );
      }
    } else {
      warnings.push(
        `MercadoLibre (Google Shopping): ${shoppingResult.reason instanceof Error ? shoppingResult.reason.message : "error"}`,
      );
    }

    if (geminiListingsResult.status === "fulfilled") {
      // Grounded search can still misattribute a real URL to the wrong
      // content, but anonymously re-fetching mercadolibre.com.ar to verify
      // it hits the same account-verification bot-gate that blocks the
      // official API — an unreliable filter that discarded real listings
      // as often as fake ones. Trust the search-grounded result instead
      // (the "Encontrado vía búsqueda web" disclaimer already tells the
      // user to confirm it manually).
      mlItems.push(
        ...geminiListingsResult.value.map((l) => ({
          externalId: l.url,
          source: "gemini_research" as const,
          title: l.title,
          externalUrl: l.url,
          imageUrl: l.imageUrl,
          price: l.price,
          currency: l.currency,
          sellerName: l.sellerName,
          condition: l.condition,
        })),
      );
    } else if (geminiEnabled) {
      warnings.push(
        `MercadoLibre (búsqueda web): ${geminiListingsResult.reason instanceof Error ? geminiListingsResult.reason.message : "error"}`,
      );
    }

    const { matches: mlMatches, warning: mlWarning } = rankMlMatches(
      searchQuery,
      mlItems,
      3,
    );
    if (mlWarning) warnings.push(mlWarning);

    const [micResult, geminiSuppliers, dolarResult] =
      await Promise.allSettled([
        // Fetch more than we need — relevance filtering below drops the
        // ones that don't actually match the product.
        searchMadeInChina(englishQuery, { limit: 5 }),
        geminiEnabled
          ? researchSuppliersForProduct({
              productName,
              niche: (context.profile.nicheKeywords ?? []).join(", "),
            })
          : Promise.resolve<SupplierCandidate[]>([]),
        fetchBlueDolarRate(),
      ]);

    const suppliersRaw: SupplierOffer[] = [];
    let chinaCandidateCount = 0;
    if (micResult.status === "fulfilled") {
      for (const item of micResult.value.items) {
        chinaCandidateCount += 1;
        if (item.price == null) continue;
        if (!isRelevantSupplierTitle(englishQuery, item.title)) continue;
        suppliersRaw.push({
          title: item.title,
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
    if (chinaCandidateCount > 0 && suppliersRaw.length === 0) {
      warnings.push(
        "Encontramos ofertas en China pero ninguna coincidía con el producto — descartadas.",
      );
    }
    if (geminiSuppliers.status === "fulfilled") {
      // Gemini is already instructed to match the exact product — cheap
      // title-vs-query check first, then confirm the survivors' pages
      // actually contain the claimed offer (same hallucination risk as
      // the MercadoLibre web-search fallback).
      const relevant = geminiSuppliers.value.filter((s) =>
        isRelevantSupplierTitle(productName, s.title),
      );
      const verifiedSuppliers: SupplierCandidate[] = await verifyAll(relevant);
      for (const s of verifiedSuppliers) {
        suppliersRaw.push({
          title: s.title,
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
      if (relevant.length > 0 && verifiedSuppliers.length === 0) {
        warnings.push(
          "Gemini: encontramos proveedores por búsqueda pero no pudimos confirmar sus publicaciones — descartados.",
        );
      }
    } else if (geminiEnabled) {
      warnings.push("Gemini: no se pudieron buscar proveedores");
    }

    const suppliersFinal = capSuppliersByCountry(suppliersRaw, 2, 6);
    if (suppliersFinal.length === 0) {
      warnings.push("No encontramos proveedores verificables para este producto.");
    }

    const bestMl = mlMatches[0];
    const estimatedSalePrice =
      bestMl && (bestMl.currency === "ARS" || bestMl.currency == null)
        ? bestMl.price ?? null
        : null;
    const blueRate =
      dolarResult.status === "fulfilled" ? dolarResult.value : null;
    const hasUsdSupplier = suppliersFinal.some((s) => s.currency === "USD");
    if (hasUsdSupplier && blueRate == null) {
      warnings.push(
        "No pudimos obtener la cotización del dólar blue (dolarapi.com) — el margen para proveedores en USD no se pudo calcular.",
      );
    }
    const brlRate = numFromEnv("TREND_RADAR_BRL_ARS_RATE");
    const profit = computeProfitEstimate({
      suppliers: suppliersFinal,
      estimatedSalePrice,
      fxUsdArs: blueRate != null ? { rate: blueRate, source: DOLAR_API_SOURCE_LABEL } : null,
      fxBrlArs: brlRate != null ? { rate: brlRate, source: "TREND_RADAR_BRL_ARS_RATE" } : null,
    });

    // Text similarity alone can rank same-category-but-different-product
    // ads too high (e.g. a 750ml thermos vs the 1L one being investigated)
    // — a final Gemini pass judges the shortlist directly. An explicit
    // empty verdict is trusted (shows as "no similar ads found"); only an
    // outright failure falls back to the heuristic-ranked order.
    let verifiedSimilarAds = context.similarAds;
    if (geminiEnabled && context.similarAds.length > 0) {
      const keepIds = await verifySimilarAdsWithGemini(productName, context.similarAds);
      if (keepIds) {
        verifiedSimilarAds = context.similarAds.filter((sa) => keepIds.has(sa.adId));
      }
    }
    const similarAdsFinal = verifiedSimilarAds.slice(0, 3).map((sa) => ({
      adId: sa.adId,
      pageName: sa.pageName,
      imageUrl: sa.imageUrl,
      videoUrl: sa.videoUrl,
      destinationUrl: sa.destinationUrl,
      snapshotUrl: sa.snapshotUrl,
      activeDays: sa.activeDays,
      matchScore: sa.matchScore,
      storeQualityScore: sa.storeQualityScore,
      storeQualityLabel: sa.storeQualityLabel,
    }));

    const nicheFitScore = nicheRelevance(productName, {
      keywords: context.profile.nicheKeywords,
      description: context.profile.description,
    });

    const scoreResult = computeInvestigationScore({
      targetActiveDays: context.ad.activeDays,
      targetStoreQuality: context.ad.storeQualityScore,
      similarAdCount: similarAdsFinal.length,
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
        similarAds: similarAdsFinal,
        mlMatches,
        suppliers: suppliersFinal,
        profit,
        warnings,
      },
    );

    return { status: "ready", investigationId };
  },
});
