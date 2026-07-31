/**
 * Opportunity scoring (versioned) for Trend Radar.
 * Decoupled from any marketplace source.
 */

import {
  DEFAULT_PENALTY_CAPS,
  DEFAULT_SCORE_WEIGHTS,
  SCORING_VERSION,
  type Classification,
} from "./validators";
import {
  clampScore,
  normalizeAbsoluteVelocityToScore,
  normalizeAccelerationToScore,
  normalizeGrowthToScore,
} from "./metrics";

export type ScoreWeights = typeof DEFAULT_SCORE_WEIGHTS;
export type PenaltyCaps = typeof DEFAULT_PENALTY_CAPS;

export type ScoreInputs = {
  demandGrowth: number | null;
  demandAcceleration: number | null;
  /** 0–1 fraction of independent roles/sources confirming growth. */
  crossSourceConfirmation: number | null;
  /** Positive when demand outpaces supply/competition. */
  demandSupplyGap: number | null;
  salesOrReviewsVelocity: number | null;
  /** Margin 0–1. */
  estimatedMargin: number | null;
  /** Logistics ease 0–100. */
  logisticsScore: number | null;
  /** Saturation signal 0–1 (higher = worse). */
  saturation: number | null;
  /** Seasonality 0–1 (higher = more seasonal explanation). */
  seasonality: number | null;
  /** Regulatory risk 0–1. */
  regulatoryRisk: number | null;
  /** Data quality / confidence 0–1. */
  dataQuality: number | null;
  sourceCount: number;
  expectedSources?: number;
  historyDays: number;
  confirmingRoles?: Array<"attention" | "commerce" | "sourcing">;
  confirmingSources?: string[];
  attentionDemandGrowth?: number | null;
  commerceDemandGrowth?: number | null;
  /** Active marketplace/evidence listings with URLs. */
  listingCount?: number;
  /** Latest attention buzz 0–100 (Gemini / Trends interest). */
  attentionBuzz?: number | null;
};

export type ScoreFactor = {
  name: string;
  value: number;
  contribution?: number;
  penalty?: number;
};

export type ScoreExplanation = {
  positiveFactors: ScoreFactor[];
  negativeFactors: ScoreFactor[];
  dataQuality: {
    availableSources: number;
    expectedSources: number;
    historyDays: number;
    missingFields?: string[];
  };
  whyRising: string[];
  confirmingSignals: string[];
  reducingFactors: string[];
  missingData: string[];
  confirmingRoles: Array<"attention" | "commerce" | "sourcing">;
  confirmingSources: string[];
};

export type OpportunityResult = {
  score: number;
  classification: Classification;
  confidence: number;
  explanation: ScoreExplanation;
  scoringVersion: string;
  subScores: {
    demandGrowth: number;
    acceleration: number;
    crossSource: number;
    demandSupplyGap: number;
    salesVelocity: number;
    margin: number;
    logistics: number;
  };
};

function gapToScore(gap: number | null): number {
  if (gap == null) return 40;
  // gap > 0 means demand > supply → higher score
  return clampScore(50 + gap * 50);
}

function marginToScore(margin: number | null): number {
  if (margin == null) return 40; // neutral when unknown (estimated)
  return clampScore(margin * 100);
}

export function computeOpportunityScore(
  inputs: ScoreInputs,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
  penaltyCaps: PenaltyCaps = DEFAULT_PENALTY_CAPS,
): OpportunityResult {
  const expectedSources = inputs.expectedSources ?? 3;
  const missingFields: string[] = [];
  if (inputs.demandGrowth == null) missingFields.push("demandGrowth");
  if (inputs.demandAcceleration == null) missingFields.push("acceleration");
  if (inputs.salesOrReviewsVelocity == null) {
    missingFields.push("salesOrReviewsVelocity");
  }
  if (inputs.estimatedMargin == null) missingFields.push("estimatedMargin");

  const hasClickableEvidence = (inputs.listingCount ?? 0) >= 1;
  const buzz = inputs.attentionBuzz;
  // Fresh products with a source URL should not collapse to score 0 just because
  // there is no multi-day growth series yet.
  const demandGrowthScore =
    inputs.demandGrowth != null
      ? normalizeGrowthToScore(inputs.demandGrowth)
      : buzz != null
        ? clampScore(buzz)
        : hasClickableEvidence
          ? 50
          : 0;
  const accelerationScore =
    inputs.demandAcceleration != null
      ? normalizeAccelerationToScore(inputs.demandAcceleration)
      : hasClickableEvidence || buzz != null
        ? 50
        : normalizeAccelerationToScore(null);
  const crossSourceScore = clampScore(
    (inputs.crossSourceConfirmation ?? 0) * 100,
  );
  const demandSupplyGapScore = gapToScore(inputs.demandSupplyGap);
  const salesVelocityScore = normalizeAbsoluteVelocityToScore(
    inputs.salesOrReviewsVelocity,
  );
  const marginScore = marginToScore(inputs.estimatedMargin);
  const logisticsScore = inputs.logisticsScore ?? 60;

  const positiveFactors: ScoreFactor[] = [
    {
      name: "Demand growth",
      value: demandGrowthScore,
      contribution: demandGrowthScore * weights.demandGrowth,
    },
    {
      name: "Acceleration",
      value: accelerationScore,
      contribution: accelerationScore * weights.acceleration,
    },
    {
      name: "Cross-source confirmation",
      value: crossSourceScore,
      contribution: crossSourceScore * weights.crossSource,
    },
    {
      name: "Demand vs supply",
      value: demandSupplyGapScore,
      contribution: demandSupplyGapScore * weights.demandSupplyGap,
    },
    {
      name: "Sales/reviews velocity",
      value: salesVelocityScore,
      contribution: salesVelocityScore * weights.salesVelocity,
    },
    {
      name: "Estimated margin",
      value: marginScore,
      contribution: marginScore * weights.margin,
    },
    {
      name: "Logistics ease",
      value: logisticsScore,
      contribution: logisticsScore * weights.logistics,
    },
  ];

  let raw =
    demandGrowthScore * weights.demandGrowth +
    accelerationScore * weights.acceleration +
    crossSourceScore * weights.crossSource +
    demandSupplyGapScore * weights.demandSupplyGap +
    salesVelocityScore * weights.salesVelocity +
    marginScore * weights.margin +
    logisticsScore * weights.logistics;

  const negativeFactors: ScoreFactor[] = [];

  const saturationPenalty =
    (inputs.saturation ?? 0) * penaltyCaps.saturation;
  if (saturationPenalty > 0) {
    negativeFactors.push({
      name: "Saturation",
      value: (inputs.saturation ?? 0) * 100,
      penalty: saturationPenalty,
    });
    raw -= saturationPenalty;
  }

  const seasonalityPenalty =
    (inputs.seasonality ?? 0) * penaltyCaps.seasonality;
  if (seasonalityPenalty > 0) {
    negativeFactors.push({
      name: "Seasonality",
      value: (inputs.seasonality ?? 0) * 100,
      penalty: seasonalityPenalty,
    });
    raw -= seasonalityPenalty;
  }

  const regulatoryPenalty =
    (inputs.regulatoryRisk ?? 0) * penaltyCaps.regulatoryRisk;
  if (regulatoryPenalty > 0) {
    negativeFactors.push({
      name: "Regulatory risk",
      value: (inputs.regulatoryRisk ?? 0) * 100,
      penalty: regulatoryPenalty,
    });
    raw -= regulatoryPenalty;
  }

  const quality =
    inputs.dataQuality != null
      ? Math.max(
          inputs.dataQuality,
          hasClickableEvidence ? 0.35 : 0,
          buzz != null ? 0.3 : 0,
        )
      : hasClickableEvidence
        ? 0.35
        : 0;
  const lowConfidencePenalty = (1 - quality) * penaltyCaps.lowConfidence;
  if (lowConfidencePenalty > 0.5) {
    negativeFactors.push({
      name: "Low data quality",
      value: quality * 100,
      penalty: lowConfidencePenalty,
    });
    raw -= lowConfidencePenalty;
  }

  if (inputs.sourceCount <= 1) {
    const singleSourcePenalty = penaltyCaps.singleSource;
    negativeFactors.push({
      name: "Single-source dependency",
      value: inputs.sourceCount,
      penalty: singleSourcePenalty,
    });
    raw -= singleSourcePenalty;
  }

  const score = clampScore(raw);
  const confidence = computeConfidence({
    historyDays: inputs.historyDays,
    sourceCount: inputs.sourceCount,
    expectedSources,
    missingFieldRatio: missingFields.length / 6,
    dataQuality: quality,
  });

  const classification = classifyOpportunity({
    score,
    demandGrowth: inputs.demandGrowth,
    demandAcceleration: inputs.demandAcceleration,
    saturation: inputs.saturation,
    seasonality: inputs.seasonality,
    crossSourceConfirmation: inputs.crossSourceConfirmation,
    sourceCount: inputs.sourceCount,
    historyDays: inputs.historyDays,
    salesOrReviewsVelocity: inputs.salesOrReviewsVelocity,
    listingCount: inputs.listingCount ?? 0,
    attentionBuzz: inputs.attentionBuzz ?? null,
  });

  const whyRising: string[] = [];
  const confirmingSignals: string[] = [];
  const reducingFactors: string[] = [];
  const missingData = [...missingFields];

  if ((inputs.demandGrowth ?? 0) > 0.1) {
    whyRising.push("Crecimiento de demanda positivo en la ventana analizada");
  }
  if ((inputs.attentionDemandGrowth ?? 0) > 0.1) {
    whyRising.push("Atención en alza (Trends / social)");
  }
  if ((inputs.commerceDemandGrowth ?? 0) > 0.1) {
    whyRising.push("Señal comercial en alza (marketplaces)");
  }
  if ((inputs.demandAcceleration ?? 0) > 0) {
    whyRising.push("Aceleración positiva (velocidad reciente > período anterior)");
  }
  if ((inputs.crossSourceConfirmation ?? 0) >= 0.5) {
    confirmingSignals.push(
      `Confirmación en ${(inputs.crossSourceConfirmation! * 100).toFixed(0)}% de roles esperados`,
    );
  }
  for (const role of inputs.confirmingRoles ?? []) {
    confirmingSignals.push(`Rol confirmando: ${role}`);
  }
  for (const src of inputs.confirmingSources ?? []) {
    confirmingSignals.push(`Fuente: ${src}`);
  }
  if ((inputs.salesOrReviewsVelocity ?? 0) > 0) {
    confirmingSignals.push("Velocidad positiva de ventas o reseñas");
  }
  for (const f of negativeFactors) {
    reducingFactors.push(
      `${f.name}${f.penalty != null ? ` (−${f.penalty.toFixed(1)})` : ""}`,
    );
  }
  if (inputs.historyDays < 14) {
    missingData.push("historial < 14 días");
  }
  if (inputs.sourceCount < expectedSources) {
    missingData.push(
      `fuentes ${inputs.sourceCount}/${expectedSources}`,
    );
  }

  return {
    score,
    classification,
    confidence,
    scoringVersion: SCORING_VERSION,
    subScores: {
      demandGrowth: demandGrowthScore,
      acceleration: accelerationScore,
      crossSource: crossSourceScore,
      demandSupplyGap: demandSupplyGapScore,
      salesVelocity: salesVelocityScore,
      margin: marginScore,
      logistics: logisticsScore,
    },
    explanation: {
      positiveFactors,
      negativeFactors,
      dataQuality: {
        availableSources: inputs.sourceCount,
        expectedSources,
        historyDays: inputs.historyDays,
        missingFields,
      },
      whyRising,
      confirmingSignals,
      reducingFactors,
      missingData,
      confirmingRoles: inputs.confirmingRoles ?? [],
      confirmingSources: inputs.confirmingSources ?? [],
    },
  };
}

export type ClassificationInputs = {
  score: number;
  demandGrowth: number | null;
  demandAcceleration: number | null;
  saturation: number | null;
  seasonality: number | null;
  crossSourceConfirmation: number | null;
  sourceCount: number;
  historyDays: number;
  salesOrReviewsVelocity: number | null;
  listingCount?: number;
  attentionBuzz?: number | null;
};

export function classifyOpportunity(
  inputs: ClassificationInputs,
): Classification {
  const hasEvidence = (inputs.listingCount ?? 0) >= 1;
  const minHistory = 7;

  // Day-1 concrete products (with clickable source) get a provisional label
  // instead of INSUFFICIENT_DATA forever until history accumulates.
  if (inputs.historyDays < minHistory || inputs.sourceCount === 0) {
    if (
      hasEvidence &&
      inputs.sourceCount >= 1 &&
      (inputs.score >= 40 || (inputs.attentionBuzz ?? 0) >= 40)
    ) {
      return "EMERGING";
    }
    return "INSUFFICIENT_DATA";
  }

  const seasonality = inputs.seasonality ?? 0;
  const saturation = inputs.saturation ?? 0;
  const growth = inputs.demandGrowth ?? 0;
  const accel = inputs.demandAcceleration ?? 0;
  const cross = inputs.crossSourceConfirmation ?? 0;
  const salesVel = inputs.salesOrReviewsVelocity;

  if (seasonality >= 0.65 && growth > 0) {
    return "SEASONAL";
  }

  if (
    growth > 0.15 &&
    (cross < 0.34 || (salesVel != null && salesVel < 0)) &&
    inputs.sourceCount === 1
  ) {
    return "FALSE_SIGNAL";
  }

  if (growth > 0 && saturation >= 0.6) {
    return "SATURATING";
  }

  if (
    inputs.score >= 75 &&
    cross >= 0.5 &&
    inputs.sourceCount >= 2 &&
    inputs.historyDays >= 14
  ) {
    return "CONFIRMED";
  }

  if (
    inputs.score >= 70 &&
    growth > 0 &&
    accel > 0 &&
    saturation < 0.55
  ) {
    return "EMERGING";
  }

  if (inputs.historyDays < 14 || inputs.sourceCount < 2) {
    if (hasEvidence && inputs.score >= 40) return "EMERGING";
    return "INSUFFICIENT_DATA";
  }

  if (saturation >= 0.55 && growth > 0) return "SATURATING";
  if (inputs.score >= 70 && growth > 0) return "EMERGING";

  return "INSUFFICIENT_DATA";
}

export type ConfidenceInputs = {
  historyDays: number;
  sourceCount: number;
  expectedSources: number;
  missingFieldRatio: number;
  dataQuality: number;
  metricStability?: number;
  listingCount?: number;
};

export function computeConfidence(inputs: ConfidenceInputs): number {
  const historyScore = clampScore((inputs.historyDays / 30) * 100);
  const sourceScore = clampScore(
    (inputs.sourceCount / Math.max(1, inputs.expectedSources)) * 100,
  );
  const completenessScore = clampScore((1 - inputs.missingFieldRatio) * 100);
  const qualityScore = clampScore(inputs.dataQuality * 100);
  const stabilityScore = clampScore((inputs.metricStability ?? 0.5) * 100);
  const listingScore = clampScore(
    Math.min(1, (inputs.listingCount ?? 1) / 5) * 100,
  );

  return clampScore(
    historyScore * 0.25 +
      sourceScore * 0.25 +
      completenessScore * 0.2 +
      qualityScore * 0.15 +
      stabilityScore * 0.1 +
      listingScore * 0.05,
  );
}
