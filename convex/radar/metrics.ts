/**
 * Historical metric helpers for Trend Radar.
 * Pure functions — unit-testable.
 */

export function growth(
  currentValue: number | null | undefined,
  previousValue: number | null | undefined,
): number | null {
  if (currentValue == null || previousValue == null) return null;
  if (previousValue === 0) {
    // No meaningful relative growth from zero; treat as null for scoring.
    return currentValue > 0 ? null : 0;
  }
  return (currentValue - previousValue) / previousValue;
}

/**
 * Percent change over a window. Uses values at `now` and `now - windowDays`.
 */
export function velocity(
  currentValue: number | null | undefined,
  previousValue: number | null | undefined,
): number | null {
  return growth(currentValue, previousValue);
}

/**
 * Acceleration = current period velocity − previous period velocity.
 */
export function acceleration(
  currentPeriodVelocity: number | null | undefined,
  previousPeriodVelocity: number | null | undefined,
): number | null {
  if (currentPeriodVelocity == null || previousPeriodVelocity == null) {
    return null;
  }
  return currentPeriodVelocity - previousPeriodVelocity;
}

export function reviewsVelocity(
  currentReviewCount: number | null | undefined,
  previousReviewCount: number | null | undefined,
): number | null {
  if (currentReviewCount == null || previousReviewCount == null) return null;
  return currentReviewCount - previousReviewCount;
}

export function salesVelocity(
  currentSoldQuantity: number | null | undefined,
  previousSoldQuantity: number | null | undefined,
): number | null {
  if (currentSoldQuantity == null || previousSoldQuantity == null) return null;
  return currentSoldQuantity - previousSoldQuantity;
}

export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

export function clampScore(n: number): number {
  return clamp(n, 0, 100);
}

/** Map an unbounded growth ratio into 0–100. */
export function normalizeGrowthToScore(
  g: number | null | undefined,
  saturatingAt = 1,
): number {
  if (g == null) return 0;
  if (g <= 0) return clampScore(50 + g * 50);
  return clampScore(50 + (g / saturatingAt) * 50);
}

/** Map acceleration into 0–100 (0 accel → 50). */
export function normalizeAccelerationToScore(
  a: number | null | undefined,
  saturatingAt = 0.5,
): number {
  if (a == null) return 0;
  return clampScore(50 + (a / saturatingAt) * 50);
}

/** Absolute delta velocity → 0–100. */
export function normalizeAbsoluteVelocityToScore(
  delta: number | null | undefined,
  saturatingAt = 50,
): number {
  if (delta == null) return 0;
  if (delta <= 0) return clampScore(40 + delta);
  return clampScore(50 + (delta / saturatingAt) * 50);
}

export type TimeSeriesPoint = {
  at: number;
  value: number | null | undefined;
};

/**
 * Find the value closest to `targetAt` within `toleranceMs`.
 */
export function valueNear(
  series: TimeSeriesPoint[],
  targetAt: number,
  toleranceMs = 36 * 60 * 60 * 1000,
): number | null {
  let best: TimeSeriesPoint | null = null;
  let bestDist = Infinity;
  for (const p of series) {
    if (p.value == null) continue;
    const dist = Math.abs(p.at - targetAt);
    if (dist <= toleranceMs && dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best?.value ?? null;
}

export function periodKeyFromTs(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysAgoTs(from: number, days: number): number {
  return from - days * 24 * 60 * 60 * 1000;
}

export const METRIC_WINDOWS = [7, 14, 30] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];
