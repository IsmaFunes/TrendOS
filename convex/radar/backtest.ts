/**
 * Conceptual backtesting helper for Trend Radar.
 * Ensures no future leakage when evaluating historical features/scores.
 */

export type BacktestPoint = {
  productId: string;
  asOf: number;
  features: Record<string, number | null>;
  score: number;
  classification: string;
  /** Observed demand growth AFTER asOf — only for evaluation, never for features. */
  realizedGrowth7d?: number | null;
  realizedGrowth14d?: number | null;
  realizedGrowth28d?: number | null;
};

export type BacktestInput = {
  trainingEndDate: number;
  predictionStartDate: number;
  predictionEndDate: number;
  targetGrowth: number;
  targetWindowDays: 7 | 14 | 28;
  points: BacktestPoint[];
};

export type BacktestResult = {
  sampleSize: number;
  hitRate: number;
  averageScoreWhenHit: number;
  averageScoreWhenMiss: number;
  /** Feature flag: full ML training not included in MVP. */
  mode: "evaluation_only";
};

function realizedForWindow(
  point: BacktestPoint,
  window: 7 | 14 | 28,
): number | null {
  switch (window) {
    case 7:
      return point.realizedGrowth7d ?? null;
    case 14:
      return point.realizedGrowth14d ?? null;
    case 28:
      return point.realizedGrowth28d ?? null;
    default: {
      const _exhaustive: never = window;
      return _exhaustive;
    }
  }
}

/**
 * Evaluate whether scores at predictionStart predicted later growth.
 * Features on each point must have been computed with data ≤ asOf only.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  if (input.predictionStartDate < input.trainingEndDate) {
    throw new Error(
      "predictionStartDate must be >= trainingEndDate (no training leakage)",
    );
  }

  const eligible = input.points.filter(
    (p) =>
      p.asOf >= input.predictionStartDate &&
      p.asOf <= input.predictionEndDate,
  );

  let hits = 0;
  let hitScoreSum = 0;
  let missScoreSum = 0;
  let missCount = 0;

  for (const point of eligible) {
    const realized = realizedForWindow(point, input.targetWindowDays);
    if (realized == null) continue;
    const hit = realized >= input.targetGrowth;
    if (hit) {
      hits += 1;
      hitScoreSum += point.score;
    } else {
      missCount += 1;
      missScoreSum += point.score;
    }
  }

  const evaluated = hits + missCount;
  return {
    sampleSize: evaluated,
    hitRate: evaluated === 0 ? 0 : hits / evaluated,
    averageScoreWhenHit: hits === 0 ? 0 : hitScoreSum / hits,
    averageScoreWhenMiss: missCount === 0 ? 0 : missScoreSum / missCount,
    mode: "evaluation_only",
  };
}
