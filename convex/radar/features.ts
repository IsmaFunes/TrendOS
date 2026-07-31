/**
 * Historical metric helpers for Trend Radar — role-aware multi-source features.
 */

import {
  periodKeyFromTs,
  daysAgoTs,
  growth,
  velocity,
  acceleration,
  reviewsVelocity,
  salesVelocity,
  valueNear,
  type TimeSeriesPoint,
} from "./metrics";
import type { DataSource, SignalRole } from "./validators";
import { roleForSource } from "./providers/registry";

export type SnapshotRow = {
  productId: string;
  source: DataSource;
  capturedAt: number;
  periodKey: string;
  price?: number;
  soldQuantity?: number;
  reviewCount?: number;
  sellerCount?: number;
  listingCount?: number;
  mentionCount?: number;
  viewCount?: number;
  searchInterest?: number;
};

export type AggregatedFeatures = {
  windowDays: number;
  demandGrowth: number | null;
  demandVelocity: number | null;
  demandAcceleration: number | null;
  /** Attention-only demand (Trends + social). */
  attentionDemandGrowth: number | null;
  /** Commerce marketplace demand (ML + AliExpress sold/reviews). */
  commerceDemandGrowth: number | null;
  /** Sourcing fit proxy from wholesale-linked snapshots (price availability). */
  sourcingFitGrowth: number | null;
  reviewsVelocity: number | null;
  salesVelocity: number | null;
  socialVelocity: number | null;
  sellerGrowth: number | null;
  listingGrowth: number | null;
  competitionRatio: number | null;
  priceChange: number | null;
  crossSourceConfirmation: number | null;
  confirmingRoles: SignalRole[];
  confirmingSources: DataSource[];
  historyDays: number;
  sourceCount: number;
  growingSources: number;
  expectedSources: number;
  expectedRoles: number;
};

function seriesFor(
  snapshots: SnapshotRow[],
  field: keyof SnapshotRow,
): TimeSeriesPoint[] {
  return snapshots
    .map((s) => ({
      at: s.capturedAt,
      value: s[field] as number | null | undefined,
    }))
    .sort((a, b) => a.at - b.at);
}

function mapRole(source: DataSource): SignalRole | null {
  const r = roleForSource(source);
  if (r === "discovery" || r === "attention") return "attention";
  if (r === "commerce") return "commerce";
  if (r === "sourcing") return "sourcing";
  return null;
}

function filterByRole(
  snapshots: SnapshotRow[],
  role: SignalRole,
): SnapshotRow[] {
  return snapshots.filter((s) => mapRole(s.source) === role);
}

/** Attention series: search interest, else mentions/views. */
function pickAttentionSeries(snapshots: SnapshotRow[]): TimeSeriesPoint[] {
  const interest = seriesFor(snapshots, "searchInterest").filter(
    (p) => p.value != null,
  );
  if (interest.length >= 2) return interest;
  const mentions = seriesFor(snapshots, "mentionCount").filter(
    (p) => p.value != null,
  );
  if (mentions.length >= 2) return mentions;
  return seriesFor(snapshots, "viewCount").filter((p) => p.value != null);
}

/** Commerce series: sold quantity, else reviews. */
function pickCommerceSeries(snapshots: SnapshotRow[]): TimeSeriesPoint[] {
  const sold = seriesFor(snapshots, "soldQuantity").filter(
    (p) => p.value != null,
  );
  if (sold.length >= 2) return sold;
  return seriesFor(snapshots, "reviewCount").filter((p) => p.value != null);
}

/** Sourcing: wholesale price presence / listing count as availability proxy. */
function pickSourcingSeries(snapshots: SnapshotRow[]): TimeSeriesPoint[] {
  const listings = seriesFor(snapshots, "listingCount").filter(
    (p) => p.value != null,
  );
  if (listings.length >= 2) return listings;
  return seriesFor(snapshots, "price").filter((p) => p.value != null);
}

function growthInWindow(
  series: TimeSeriesPoint[],
  asOf: number,
  windowDays: number,
): number | null {
  return growth(
    valueNear(series, asOf),
    valueNear(series, daysAgoTs(asOf, windowDays)),
  );
}

export function computeFeaturesFromSnapshots(
  snapshots: SnapshotRow[],
  windowDays: number,
  asOf: number = Date.now(),
  options?: { expectedSources?: number; expectedRoles?: number },
): AggregatedFeatures {
  const expectedSources = options?.expectedSources ?? 3;
  const expectedRoles = options?.expectedRoles ?? 3;

  const history = snapshots.filter((s) => s.capturedAt <= asOf);
  const sources = new Set(history.map((s) => s.source));
  const oldest = history.reduce(
    (min, s) => Math.min(min, s.capturedAt),
    asOf,
  );
  const historyDays =
    history.length === 0
      ? 0
      : Math.floor((asOf - oldest) / (24 * 60 * 60 * 1000));

  const attentionSnaps = filterByRole(history, "attention");
  const commerceSnaps = filterByRole(history, "commerce");
  const sourcingSnaps = filterByRole(history, "sourcing");

  const attentionSeries = pickAttentionSeries(attentionSnaps);
  const commerceSeries = pickCommerceSeries(commerceSnaps);
  const sourcingSeries = pickSourcingSeries(sourcingSnaps);

  const attentionDemandGrowth = growthInWindow(
    attentionSeries,
    asOf,
    windowDays,
  );
  const commerceDemandGrowth = growthInWindow(
    commerceSeries,
    asOf,
    windowDays,
  );
  const sourcingFitGrowth = growthInWindow(sourcingSeries, asOf, windowDays);

  // Primary demand for legacy fields: prefer attention, then commerce.
  const primarySeries =
    attentionSeries.length >= 2
      ? attentionSeries
      : commerceSeries.length >= 2
        ? commerceSeries
        : sourcingSeries;
  const current = valueNear(primarySeries, asOf);
  const prev = valueNear(primarySeries, daysAgoTs(asOf, windowDays));
  const prevPrev = valueNear(primarySeries, daysAgoTs(asOf, windowDays * 2));

  const demandGrowth = growth(current, prev);
  const demandVelocity = velocity(current, prev);
  const prevVelocity = velocity(prev, prevPrev);
  const demandAcceleration = acceleration(demandVelocity, prevVelocity);

  const reviews = seriesFor(commerceSnaps, "reviewCount");
  const sales = seriesFor(commerceSnaps, "soldQuantity");
  const social = seriesFor(attentionSnaps, "mentionCount");
  const sellers = seriesFor(commerceSnaps, "sellerCount");
  const listings = seriesFor(commerceSnaps, "listingCount");
  const prices = seriesFor(commerceSnaps, "price");

  const rv = reviewsVelocity(
    valueNear(reviews, asOf),
    valueNear(reviews, daysAgoTs(asOf, windowDays)),
  );
  const sv = salesVelocity(
    valueNear(sales, asOf),
    valueNear(sales, daysAgoTs(asOf, windowDays)),
  );
  const socialVel = salesVelocity(
    valueNear(social, asOf),
    valueNear(social, daysAgoTs(asOf, windowDays)),
  );
  const sellerGrowth = growth(
    valueNear(sellers, asOf),
    valueNear(sellers, daysAgoTs(asOf, windowDays)),
  );
  const listingGrowth = growth(
    valueNear(listings, asOf),
    valueNear(listings, daysAgoTs(asOf, windowDays)),
  );
  const priceChange = growth(
    valueNear(prices, asOf),
    valueNear(prices, daysAgoTs(asOf, windowDays)),
  );

  const demandNow = valueNear(primarySeries, asOf) ?? 0;
  const listingNow = valueNear(listings, asOf) ?? 0;
  const competitionRatio =
    listingNow > 0 ? demandNow / listingNow : null;

  let growingSources = 0;
  const confirmingSources: DataSource[] = [];
  for (const source of sources) {
    const subset = history.filter((s) => s.source === source);
    const role = mapRole(source);
    const series =
      role === "attention"
        ? pickAttentionSeries(subset)
        : role === "commerce"
          ? pickCommerceSeries(subset)
          : pickSourcingSeries(subset);
    const g = growthInWindow(series, asOf, windowDays);
    if (g != null && g > 0) {
      growingSources += 1;
      confirmingSources.push(source);
    }
  }

  const confirmingRoles: SignalRole[] = [];
  if (attentionDemandGrowth != null && attentionDemandGrowth > 0) {
    confirmingRoles.push("attention");
  }
  if (commerceDemandGrowth != null && commerceDemandGrowth > 0) {
    confirmingRoles.push("commerce");
  }
  if (sourcingFitGrowth != null && sourcingFitGrowth > 0) {
    confirmingRoles.push("sourcing");
  }

  const sourceCount = sources.size;
  // Role-based cross confirmation vs configured expected roles.
  const crossSourceConfirmation =
    confirmingRoles.length === 0 && sourceCount === 0
      ? null
      : confirmingRoles.length / Math.max(expectedRoles, 1);

  return {
    windowDays,
    demandGrowth,
    demandVelocity,
    demandAcceleration,
    attentionDemandGrowth,
    commerceDemandGrowth,
    sourcingFitGrowth,
    reviewsVelocity: rv,
    salesVelocity: sv,
    socialVelocity: socialVel,
    sellerGrowth,
    listingGrowth,
    competitionRatio,
    priceChange,
    crossSourceConfirmation,
    confirmingRoles,
    confirmingSources,
    historyDays,
    sourceCount,
    growingSources,
    expectedSources,
    expectedRoles,
  };
}

export function saturationFromFeatures(features: AggregatedFeatures): number {
  let sat = 0;
  if ((features.sellerGrowth ?? 0) > 0.3) sat += 0.35;
  if ((features.listingGrowth ?? 0) > 0.3) sat += 0.35;
  if ((features.priceChange ?? 0) < -0.1) sat += 0.2;
  if (features.competitionRatio != null && features.competitionRatio < 1) {
    sat += 0.15;
  }
  return Math.min(1, sat);
}

export { periodKeyFromTs };
