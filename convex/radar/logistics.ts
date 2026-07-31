/**
 * Margin and logistics scoring for Trend Radar.
 */

import { clampScore } from "./metrics";

export type BusinessCosts = {
  purchaseCost?: number | null;
  shippingCost?: number | null;
  taxCost?: number | null;
  platformFee?: number | null;
  packagingCost?: number | null;
  estimatedSalePrice?: number | null;
};

export type LogisticsInputs = {
  weightKg?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  depthCm?: number | null;
  regulatoryRisk?: number | null; // 0–1
  fragility?: number | null; // 0–1
  storageDifficulty?: number | null; // 0–1
  isHazardous?: boolean | null;
};

export type MarginResult = {
  estimatedProfit: number | null;
  estimatedMargin: number | null;
  isEstimated: true;
};

export function calculateMargin(costs: BusinessCosts): MarginResult {
  const sale = costs.estimatedSalePrice;
  if (sale == null || sale <= 0) {
    return { estimatedProfit: null, estimatedMargin: null, isEstimated: true };
  }
  const purchase = costs.purchaseCost ?? 0;
  const shipping = costs.shippingCost ?? 0;
  const tax = costs.taxCost ?? 0;
  const fee = costs.platformFee ?? 0;
  const packaging = costs.packagingCost ?? 0;
  const estimatedProfit =
    sale - purchase - shipping - tax - fee - packaging;
  const estimatedMargin = estimatedProfit / sale;
  return { estimatedProfit, estimatedMargin, isEstimated: true };
}

/**
 * Logistics ease score 0–100 (higher = easier to ship/store).
 * All penalties are configurable via input magnitudes.
 */
export function calculateLogisticsScore(inputs: LogisticsInputs): number {
  let score = 100;

  const weight = inputs.weightKg ?? 0;
  if (weight > 0.5) score -= Math.min(25, (weight - 0.5) * 10);
  if (weight > 5) score -= 15;
  if (weight > 15) score -= 15;

  const w = inputs.widthCm ?? 0;
  const h = inputs.heightCm ?? 0;
  const d = inputs.depthCm ?? 0;
  const volumeLiters = (w * h * d) / 1000;
  if (volumeLiters > 5) score -= Math.min(20, (volumeLiters - 5) * 2);
  if (volumeLiters > 30) score -= 15;

  score -= (inputs.fragility ?? 0) * 20;
  score -= (inputs.storageDifficulty ?? 0) * 15;
  score -= (inputs.regulatoryRisk ?? 0) * 25;
  if (inputs.isHazardous) score -= 30;

  return clampScore(score);
}
