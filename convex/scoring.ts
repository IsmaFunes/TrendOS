export type MlBucket = "fastest_growing" | "most_wanted" | "rising";

export type ScoreSignals = {
  mlPosition?: number;
  mlBucket?: MlBucket;
  googleInterest?: number;
  webBuzz?: number;
  previousScore?: number;
  previousPosition?: number;
};

/** Local ML↔web name match must meet this to attach ML sales bonus. */
export const WEB_MATCH_MIN_CONFIDENCE = 0.55;

export type ScoreEntry = {
  key: string;
  label: string;
  raw: string;
  weight: number;
  contribution: number;
  reason: string;
};

export type ScoreBreakdown = {
  entityType: "product" | "keyword";
  trendScore: number;
  entries: ScoreEntry[];
};

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function mlPositionScore(position?: number): number {
  if (position === undefined || position < 1 || position > 20) return 0;
  return clamp01(1 - (position - 1) / 19);
}

export function mlBucketScore(bucket?: MlBucket): number {
  switch (bucket) {
    case "fastest_growing":
      return 1;
    case "most_wanted":
      return 0.75;
    case "rising":
      return 0.55;
    case undefined:
      return 0;
    default: {
      const _exhaustive: never = bucket;
      return _exhaustive;
    }
  }
}

export function googleInterestScore(interest?: number): number {
  if (interest === undefined) return 0;
  return clamp01(interest / 100);
}

export function webBuzzScore(webBuzz?: number): number {
  if (webBuzz === undefined) return 0;
  return clamp01(webBuzz / 100);
}

function isKeywordSignals(signals: ScoreSignals): boolean {
  return (
    signals.mlBucket !== undefined &&
    signals.mlPosition === undefined &&
    signals.webBuzz === undefined
  );
}

function baseScore(signals: ScoreSignals): number {
  if (isKeywordSignals(signals)) {
    return clamp01(
      0.55 * mlBucketScore(signals.mlBucket) +
        0.25 * googleInterestScore(signals.googleInterest),
    );
  }

  // Products: favor sales velocity for e‑commerce / dropshipping fit.
  // When ML sales aren't available (common for niche web discoveries),
  // redistribute that weight to web buzz so scores aren't artificially capped ~0.35.
  const hasMl =
    signals.mlPosition !== undefined &&
    signals.mlPosition >= 1 &&
    signals.mlPosition <= 20;
  const wWeb = hasMl ? 0.35 : 0.6;
  const wG = 0.2;
  const wMl = hasMl ? 0.25 : 0;
  return clamp01(
    wWeb * webBuzzScore(signals.webBuzz) +
      wG * googleInterestScore(signals.googleInterest) +
      wMl * mlPositionScore(signals.mlPosition),
  );
}

function velocityScore(signals: ScoreSignals): number {
  let bonus = 0;
  if (signals.previousScore !== undefined) {
    const delta = baseScore(signals) - signals.previousScore;
    if (delta > 0) bonus += Math.min(1, delta * 2);
  }
  if (
    signals.previousPosition !== undefined &&
    signals.mlPosition !== undefined &&
    signals.mlPosition < signals.previousPosition
  ) {
    bonus += Math.min(
      1,
      (signals.previousPosition - signals.mlPosition) / 10,
    );
  }
  return clamp01(bonus);
}

/**
 * Products (with ML): clamp(0.35*webBuzz + 0.20*gTrends + 0.25*mlPos + 0.20*velocity, 0, 1)
 * Products (web-only): clamp(0.60*webBuzz + 0.20*gTrends + 0.20*velocity, 0, 1)
 * Keywords: clamp(0.55*mlBucket + 0.25*gTrends + 0.10*velocity, 0, 1)
 */
export function computeTrendScore(signals: ScoreSignals): number {
  const velocityWeight = isKeywordSignals(signals) ? 0.1 : 0.2;
  return clamp01(baseScore(signals) + velocityWeight * velocityScore(signals));
}

export type WebMatchContext = {
  rawWebBuzz?: number;
  /** Local name-match confidence to an ML listing (optional). */
  confidence?: number;
  webProductName?: string;
  sources?: string[];
  rationale?: string;
  /** True when this row came from web discovery (buzz always counts). */
  fromWebDiscovery?: boolean;
};

/**
 * Explain each score input: raw signal, weight, contribution, and decision reason.
 */
export function explainScoreBreakdown(
  signals: ScoreSignals,
  webMatch?: WebMatchContext,
): ScoreBreakdown {
  const entityType: "product" | "keyword" = isKeywordSignals(signals)
    ? "keyword"
    : "product";
  const entries: ScoreEntry[] = [];

  if (entityType === "keyword") {
    const bucketNorm = mlBucketScore(signals.mlBucket);
    entries.push({
      key: "mlBucket",
      label: "ML keyword bucket",
      raw: signals.mlBucket ?? "n/a",
      weight: 0.55,
      contribution: 0.55 * bucketNorm,
      reason: signals.mlBucket
        ? `Bucket ML "${signals.mlBucket}" → norma ${bucketNorm.toFixed(2)}`
        : "Sin bucket ML → contribución 0",
    });

    const gNorm = googleInterestScore(signals.googleInterest);
    entries.push({
      key: "googleInterest",
      label: "Google Trends",
      raw:
        signals.googleInterest !== undefined
          ? String(signals.googleInterest)
          : "n/a",
      weight: 0.25,
      contribution: 0.25 * gNorm,
      reason:
        signals.googleInterest !== undefined
          ? `Interest ${signals.googleInterest}/100 → norma ${gNorm.toFixed(2)}`
          : "Sin interest → 0",
    });
  } else {
    const webNorm = webBuzzScore(signals.webBuzz);
    let webReason: string;
    if (signals.webBuzz !== undefined) {
      webReason = webMatch?.fromWebDiscovery
        ? `Discovery web independiente: buzz ${signals.webBuzz}/100 → norma ${webNorm.toFixed(2)}${webMatch.rationale ? ` · ${webMatch.rationale}` : ""}`
        : `Buzz web ${signals.webBuzz}/100 → norma ${webNorm.toFixed(2)}`;
    } else {
      webReason =
        "Sin discovery web para este producto → base web 0 (solo señales ML/Trends)";
    }
    const hasMl =
      signals.mlPosition !== undefined &&
      signals.mlPosition >= 1 &&
      signals.mlPosition <= 20;
    const wWeb = hasMl ? 0.35 : 0.6;
    const wMl = hasMl ? 0.25 : 0;

    entries.push({
      key: "webBuzz",
      label: "Web buzz (independiente)",
      raw:
        signals.webBuzz !== undefined ? String(signals.webBuzz) : "n/a",
      weight: wWeb,
      contribution: wWeb * webNorm,
      reason: hasMl
        ? webReason
        : `${webReason} · peso sube a ${wWeb} (sin ventas ML)`,
    });

    const gNorm = googleInterestScore(signals.googleInterest);
    entries.push({
      key: "googleInterest",
      label: "Google Trends",
      raw:
        signals.googleInterest !== undefined
          ? String(signals.googleInterest)
          : "n/a",
      weight: 0.2,
      contribution: 0.2 * gNorm,
      reason:
        signals.googleInterest !== undefined
          ? `Interest ${signals.googleInterest}/100 → norma ${gNorm.toFixed(2)} (suma)`
          : "Sin interest → 0",
    });

    const posNorm = mlPositionScore(signals.mlPosition);
    let mlReason: string;
    if (hasMl) {
      const matchNote =
        webMatch?.confidence !== undefined
          ? ` · link web↔ML conf=${webMatch.confidence.toFixed(2)}`
          : "";
      mlReason = `Ventas ML #${signals.mlPosition}/20 → norma ${posNorm.toFixed(2)} (bonus sobre buzz)${matchNote}`;
    } else if (
      webMatch?.fromWebDiscovery &&
      (webMatch.confidence === undefined ||
        webMatch.confidence < WEB_MATCH_MIN_CONFIDENCE)
    ) {
      mlReason = `Sin match local a catálogo ML (conf=${(webMatch.confidence ?? 0).toFixed(2)} < ${WEB_MATCH_MIN_CONFIDENCE}) → peso redistribuido a web`;
    } else {
      mlReason = "Sin posición ML 1–20 → peso redistribuido a web";
    }
    entries.push({
      key: "mlPosition",
      label: "ML sales bonus",
      raw:
        signals.mlPosition !== undefined ? `#${signals.mlPosition}` : "n/a",
      weight: wMl,
      contribution: wMl * posNorm,
      reason: mlReason,
    });
  }

  const velNorm = velocityScore(signals);
  const velocityWeight = entityType === "keyword" ? 0.1 : 0.2;
  const velBits: string[] = [];
  if (
    signals.previousScore === undefined &&
    signals.previousPosition === undefined
  ) {
    velBits.push("sin snapshot previo");
  } else {
    if (signals.previousScore !== undefined) {
      const delta = baseScore(signals) - signals.previousScore;
      velBits.push(
        delta > 0
          ? `score subió vs previo (${signals.previousScore.toFixed(2)} → base ${baseScore(signals).toFixed(2)})`
          : `score no subió vs previo (${signals.previousScore.toFixed(2)})`,
      );
    }
    if (
      signals.previousPosition !== undefined &&
      signals.mlPosition !== undefined
    ) {
      if (signals.mlPosition < signals.previousPosition) {
        velBits.push(
          `subió en ranking ML (#${signals.previousPosition} → #${signals.mlPosition})`,
        );
      } else {
        velBits.push(
          `posición ML estable/peor (#${signals.previousPosition} → #${signals.mlPosition})`,
        );
      }
    }
  }

  entries.push({
    key: "velocity",
    label: "Velocity",
    raw: velNorm.toFixed(2),
    weight: velocityWeight,
    contribution: velocityWeight * velNorm,
    reason: velBits.join("; "),
  });

  return {
    entityType,
    trendScore: computeTrendScore(signals),
    entries,
  };
}

export function formatScoreBreakdownLog(
  title: string,
  meta: { categoryName: string; siteId: string; id?: string },
  breakdown: ScoreBreakdown,
): string {
  const lines = [
    `[score] ${breakdown.entityType.toUpperCase()} "${title}"`,
    `  category=${meta.categoryName} site=${meta.siteId}${meta.id ? ` id=${meta.id}` : ""}`,
    `  trendScore=${breakdown.trendScore.toFixed(3)}`,
  ];
  for (const e of breakdown.entries) {
    lines.push(
      `  · ${e.key} (w=${e.weight}): raw=${e.raw} contrib=${e.contribution.toFixed(3)} — ${e.reason}`,
    );
  }
  return lines.join("\n");
}

export function bucketFromTrendIndex(index: number): MlBucket {
  if (index < 10) return "fastest_growing";
  if (index < 30) return "most_wanted";
  return "rising";
}
