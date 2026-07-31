/**
 * Multi-stage product matching. LLM is optional and never auto-merges on low confidence.
 */

import {
  detectBrandModel,
  normalizeAlias,
  textSimilarity,
} from "./normalize";
import type { DataSource } from "./validators";

export type MatchCandidate = {
  productId: string;
  canonicalName: string;
  brand?: string;
  model?: string;
  aliases: string[];
  categoryId?: string;
};

export type ListingIdentity = {
  source: DataSource;
  externalId: string;
  title: string;
  brand?: string;
  model?: string;
  categoryExternalId?: string;
};

export type MatchResult = {
  productId?: string;
  confidence: number;
  method:
    | "exact_external_id"
    | "alias"
    | "brand_model"
    | "text_similarity"
    | "category_rule"
    | "manual_required"
    | "none";
  explanation: string;
  /** When true, enqueue for human review — do not auto-merge. */
  requiresManualReview: boolean;
};

export type LlmMatchAdvisor = {
  enabled: boolean;
  suggestMerge(input: {
    listingTitle: string;
    candidateName: string;
  }): Promise<{ confidence: number; explanation: string } | null>;
};

const AUTO_MERGE_THRESHOLD = 0.85;
const MANUAL_REVIEW_THRESHOLD = 0.45;

/**
 * Stage 1: exact external id is handled by the caller (listing unique index).
 * Stages 2–5: alias → brand+model → text → category soft boost.
 */
export function matchListingToProduct(
  listing: ListingIdentity,
  candidates: MatchCandidate[],
  options?: { categoryBoostIds?: Set<string> },
): MatchResult {
  const normalizedTitle = normalizeAlias(listing.title);
  if (!normalizedTitle) {
    return {
      confidence: 0,
      method: "none",
      explanation: "Título vacío tras normalización",
      requiresManualReview: true,
    };
  }

  // Stage 2: alias exact match
  for (const c of candidates) {
    for (const alias of c.aliases) {
      if (normalizeAlias(alias) === normalizedTitle) {
        return {
          productId: c.productId,
          confidence: 0.98,
          method: "alias",
          explanation: `Alias exacto: "${alias}"`,
          requiresManualReview: false,
        };
      }
    }
    if (normalizeAlias(c.canonicalName) === normalizedTitle) {
      return {
        productId: c.productId,
        confidence: 0.97,
        method: "alias",
        explanation: "Nombre canónico exacto",
        requiresManualReview: false,
      };
    }
  }

  // Stage 3: brand + model
  const guessed = detectBrandModel(listing.title);
  const brand = (listing.brand ?? guessed.brand)?.toLowerCase();
  const model = (listing.model ?? guessed.model)?.toLowerCase();
  if (brand && model) {
    for (const c of candidates) {
      const cb = c.brand?.toLowerCase();
      const cm = c.model?.toLowerCase();
      if (cb === brand && cm === model) {
        return {
          productId: c.productId,
          confidence: 0.9,
          method: "brand_model",
          explanation: `Marca+modelo: ${brand} ${model}`,
          requiresManualReview: false,
        };
      }
    }
  }

  // Stage 4: text similarity
  let best: { c: MatchCandidate; score: number } | null = null;
  for (const c of candidates) {
    let score = textSimilarity(listing.title, c.canonicalName);
    for (const alias of c.aliases) {
      score = Math.max(score, textSimilarity(listing.title, alias));
    }
    // Stage 5: soft category boost
    if (
      options?.categoryBoostIds &&
      c.categoryId &&
      options.categoryBoostIds.has(c.categoryId)
    ) {
      score = Math.min(1, score + 0.05);
    }
    if (!best || score > best.score) best = { c, score };
  }

  if (!best) {
    return {
      confidence: 0,
      method: "none",
      explanation: "Sin candidatos",
      requiresManualReview: true,
    };
  }

  if (best.score >= AUTO_MERGE_THRESHOLD) {
    return {
      productId: best.c.productId,
      confidence: best.score,
      method: "text_similarity",
      explanation: `Similitud de texto ${(best.score * 100).toFixed(0)}% con "${best.c.canonicalName}"`,
      requiresManualReview: false,
    };
  }

  if (best.score >= MANUAL_REVIEW_THRESHOLD) {
    return {
      productId: best.c.productId,
      confidence: best.score,
      method: "manual_required",
      explanation: `Similitud media ${(best.score * 100).toFixed(0)}% — requiere revisión manual`,
      requiresManualReview: true,
    };
  }

  return {
    confidence: best.score,
    method: "none",
    explanation: `Mejor similitud ${(best.score * 100).toFixed(0)}% insuficiente`,
    requiresManualReview: false,
  };
}

/**
 * Optional LLM advisor — never merges automatically below AUTO_MERGE_THRESHOLD.
 */
export async function adviseWithOptionalLlm(
  base: MatchResult,
  listingTitle: string,
  candidateName: string,
  advisor?: LlmMatchAdvisor,
): Promise<MatchResult> {
  if (!advisor?.enabled) return base;
  if (base.confidence >= AUTO_MERGE_THRESHOLD && !base.requiresManualReview) {
    return base;
  }
  try {
    const suggestion = await advisor.suggestMerge({
      listingTitle,
      candidateName,
    });
    if (!suggestion) return base;
    const confidence = Math.min(suggestion.confidence, 0.84);
    return {
      ...base,
      confidence: Math.max(base.confidence, confidence),
      explanation: `${base.explanation} | LLM: ${suggestion.explanation}`,
      requiresManualReview: confidence < AUTO_MERGE_THRESHOLD,
    };
  } catch {
    return base;
  }
}
