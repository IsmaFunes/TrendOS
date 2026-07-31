/**
 * Google Trends via SerpAPI only (live path).
 * Interest values are relative 0–100 — never absolute volumes.
 * Mock mode is NOT used by operational jobs (fail-closed).
 */

import type {
  CollectResult,
  TrendingTermObservation,
  TrendingTermsInput,
  TrendDataSource,
} from "../contracts";
import { fetchJsonWithRetry, structuredLog } from "../http";

export type GoogleTrendsConfig = {
  apiKey: string;
  country?: string;
  jobId?: string;
  timeoutMs?: number;
};

type SerpInterestOverTime = {
  timeline_data?: Array<{
    date?: string;
    values?: Array<{ query?: string; value?: string; extracted_value?: number }>;
  }>;
};

type SerpRelated = {
  related_queries?: {
    rising?: Array<{ query?: string; value?: string; extracted_value?: number }>;
    top?: Array<{ query?: string; value?: string; extracted_value?: number }>;
  };
};

export function createGoogleTrendsProvider(
  config: GoogleTrendsConfig,
): TrendDataSource {
  if (!config.apiKey?.trim()) {
    throw new Error("SERPAPI_API_KEY required — Google Trends mocks disabled");
  }
  const country = config.country ?? "AR";
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    source: "google_trends",

    async collectTrendingTerms(
      input: TrendingTermsInput,
    ): Promise<CollectResult<TrendingTermObservation>> {
      const terms = input.terms?.length ? input.terms : [];
      if (terms.length === 0) {
        return {
          items: [],
          errors: [
            { message: "No search terms configured", errorType: "validation" },
          ],
          partial: true,
        };
      }

      const geo = input.country ?? country;
      const at = Date.now();
      const items: TrendingTermObservation[] = [];
      const errors: CollectResult<TrendingTermObservation>["errors"] = [];

      for (const term of terms) {
        const started = Date.now();
        const params = new URLSearchParams({
          engine: "google_trends",
          q: term,
          geo,
          api_key: config.apiKey,
          data_type: "TIMESERIES",
        });
        const tsResult = await fetchJsonWithRetry<SerpInterestOverTime>({
          url: `https://serpapi.com/search.json?${params}`,
          timeoutMs,
        });

        if (!tsResult.ok) {
          structuredLog({
            jobId: config.jobId,
            source: "google_trends",
            errorType: tsResult.errorType,
            attempt: tsResult.attempts,
            duration: Date.now() - started,
            message: tsResult.message,
          });
          errors.push({
            message: tsResult.message,
            errorType: tsResult.errorType,
          });
          continue;
        }

        const timeline = tsResult.data.timeline_data ?? [];
        const values = timeline
          .map((p) => p.values?.[0]?.extracted_value)
          .filter((v): v is number => typeof v === "number");
        const interest = values.at(-1) ?? 0;
        const slice7 = values.slice(-7);
        const avg = (arr: number[]) =>
          arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const avg7 = avg(slice7);
        const avg30 = avg(values.slice(-30));
        const prev7 = avg(values.slice(-14, -7));
        const growth7d = prev7 > 0 ? (avg7 - prev7) / prev7 : undefined;
        const growth30d =
          avg30 > 0 && values.length >= 30
            ? (avg7 - avg30) / avg30
            : undefined;

        const relatedParams = new URLSearchParams({
          engine: "google_trends",
          q: term,
          geo,
          api_key: config.apiKey,
          data_type: "RELATED_QUERIES",
        });
        const relatedResult = await fetchJsonWithRetry<SerpRelated>({
          url: `https://serpapi.com/search.json?${relatedParams}`,
          timeoutMs,
        });

        const relatedQueries: TrendingTermObservation["relatedQueries"] = [];
        if (relatedResult.ok) {
          for (const r of relatedResult.data.related_queries?.rising ?? []) {
            if (!r.query) continue;
            relatedQueries.push({
              query: r.query,
              kind: "rising",
              interest: r.extracted_value,
            });
          }
          for (const r of relatedResult.data.related_queries?.top ?? []) {
            if (!r.query) continue;
            relatedQueries.push({
              query: r.query,
              kind: "top",
              interest: r.extracted_value,
            });
          }
        }

        items.push({
          term,
          source: "google_trends",
          capturedAt: at,
          interest,
          relativeInterest: interest,
          growth7d,
          growth30d,
          breakout: (growth7d ?? 0) > 0.5,
          relatedQueries,
          isRelative: true,
        });
      }

      return {
        items,
        errors,
        partial: errors.length > 0,
      };
    },
  };
}
