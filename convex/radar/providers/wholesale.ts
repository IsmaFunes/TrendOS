/**
 * Wholesale offers — real imported catalog data (no invented prices).
 */

import { normalizeAlias } from "../normalize";

export type WholesaleOfferInput = {
  sku: string;
  title: string;
  supplierName?: string;
  currency?: string;
  unitPrice: number;
  moq?: number;
  leadTimeDays?: number;
  externalUrl?: string;
  aliases?: string[];
  productId?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export function normalizeWholesaleOffer(input: WholesaleOfferInput): {
  sku: string;
  title: string;
  normalizedTitle: string;
  normalizedAliases: string[];
  supplierName?: string;
  currency: string;
  unitPrice: number;
  moq?: number;
  leadTimeDays?: number;
  externalUrl?: string;
  metadataJson?: string;
} {
  if (!input.sku?.trim()) throw new Error("sku required");
  if (!input.title?.trim()) throw new Error("title required");
  if (!(input.unitPrice > 0)) throw new Error("unitPrice must be > 0");

  const aliases = (input.aliases ?? []).map(normalizeAlias).filter(Boolean);
  return {
    sku: input.sku.trim(),
    title: input.title.trim(),
    normalizedTitle: normalizeAlias(input.title),
    normalizedAliases: aliases,
    supplierName: input.supplierName,
    currency: input.currency ?? "USD",
    unitPrice: input.unitPrice,
    moq: input.moq,
    leadTimeDays: input.leadTimeDays,
    externalUrl: input.externalUrl,
    metadataJson: input.metadata
      ? JSON.stringify(input.metadata)
      : undefined,
  };
}

/** Sourcing fit score 0–1 from MOQ + lead time (lower friction = higher fit). */
export function wholesaleSourcingFit(offer: {
  moq?: number | null;
  leadTimeDays?: number | null;
  unitPrice?: number | null;
  estimatedSalePrice?: number | null;
}): number {
  let score = 1;
  const moq = offer.moq ?? 1;
  if (moq > 10) score -= 0.15;
  if (moq > 50) score -= 0.2;
  if (moq > 200) score -= 0.25;
  const lead = offer.leadTimeDays ?? 14;
  if (lead > 14) score -= 0.1;
  if (lead > 30) score -= 0.15;
  if (lead > 60) score -= 0.2;
  if (
    offer.unitPrice != null &&
    offer.estimatedSalePrice != null &&
    offer.estimatedSalePrice > 0
  ) {
    const margin =
      (offer.estimatedSalePrice - offer.unitPrice) / offer.estimatedSalePrice;
    if (margin < 0.2) score -= 0.25;
    else if (margin > 0.4) score += 0.1;
  }
  return Math.max(0, Math.min(1, score));
}
