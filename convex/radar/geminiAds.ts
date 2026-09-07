"use node";

/**
 * Gemini personalization: scrape-term expansion + per-user ad ranking.
 */

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fetchJsonWithRetry, structuredLog } from "./http";
import {
  buildNicheRelevancePrompt,
  buildRankingPrompt,
  buildScrapeTermsPrompt,
  extractJsonPayload,
  GEMINI_ADS_MODEL,
  MIN_FORCE_REFRESH_INTERVAL_MS,
  normalizeScrapeTerms,
  parseRankingResponse,
  RANKING_RESPONSE_SCHEMA,
  SCRAPE_TERMS_RESPONSE_SCHEMA,
} from "./geminiAdsCore";

type GeminiGenerateResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
};

function extractText(json: GeminiGenerateResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/**
 * Calls Gemini through the same retry/timeout/structured-logging path every
 * other collector in convex/radar/providers uses — this used to be a bare
 * `fetch` with no timeout, no retry on 429/5xx, and no logs to diagnose
 * failures from. Also asks for a `responseSchema` (Gemini enforces the
 * shape server-side) and checks for MAX_TOKENS truncation instead of
 * silently trying to JSON.parse a cut-off response.
 */
async function callGeminiJson(
  prompt: string,
  options: {
    label: "terms" | "ranking";
    responseSchema: unknown;
    maxOutputTokens: number;
    timeoutMs?: number;
    maxAttempts?: number;
  },
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  const started = Date.now();
  const source = `gemini_ads_${options.label}`;

  const result = await fetchJsonWithRetry<GeminiGenerateResponse>({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_ADS_MODEL}:generateContent?key=${apiKey}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: options.responseSchema,
        maxOutputTokens: options.maxOutputTokens,
        // gemini-3.6-flash is a thinking model — its reasoning tokens come
        // out of the same maxOutputTokens budget. Without capping this, a
        // longer/more-reasoning-heavy prompt (e.g. the "classify niche as
        // category vs specific product" step) can spend the whole budget
        // thinking and get cut off before ever emitting the JSON answer —
        // the same MAX_TOKENS failure already fixed once for the product-
        // extraction call in investigate.ts.
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
    timeoutMs: options.timeoutMs ?? 20_000,
    maxAttempts: options.maxAttempts,
  });

  if (!result.ok) {
    structuredLog({
      source,
      errorType: result.errorType,
      attempt: result.attempts,
      duration: Date.now() - started,
      message: result.message,
      level: "error",
    });
    throw new Error(`Gemini ${result.errorType}: ${result.message}`);
  }

  const finishReason = result.data.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    structuredLog({
      source,
      errorType: "truncated",
      attempt: result.attempts,
      duration: Date.now() - started,
      message: `Response hit maxOutputTokens=${options.maxOutputTokens}`,
      level: "warn",
    });
    throw new Error("Gemini response truncated (MAX_TOKENS)");
  }

  const text = extractText(result.data);
  if (!text) {
    structuredLog({
      source,
      errorType: "empty_response",
      attempt: result.attempts,
      duration: Date.now() - started,
      message: `finishReason=${finishReason ?? "unknown"}`,
      level: "error",
    });
    throw new Error("Gemini returned empty ranking/terms payload");
  }
  return text;
}

type EnrichResult = {
  ok: boolean;
  terms: string[];
  skipped?: string;
};

type RankingResult = {
  status:
    | "fresh"
    | "updated"
    | "no_user"
    | "no_niche"
    | "no_ads"
    | "no_gemini_key"
    | "error";
  ranked: number;
  dropped: number;
  message?: string;
};

type NicheEnrichRow = {
  nicheId: Id<"radarNiches">;
  keywords: string[];
  scrapeTerms?: string[];
  label: string;
  jobId?: Id<"radarNicheScrapeJobs">;
  jobStatus?: string;
};

type NicheRelevanceContext = {
  fingerprint: string;
  label: string;
  keywords: string[];
  ads: Array<{
    id: string;
    pageName: string;
    body: string;
    activeDays: number;
    searchTerm?: string;
    destinationUrl?: string;
  }>;
  existingFresh: boolean;
  existingCreatedAt?: number;
};

type NicheRelevanceResult = {
  status: "fresh" | "updated" | "no_niche" | "no_ads" | "no_gemini_key" | "error";
  ranked: number;
  dropped: number;
  message?: string;
};

type RankingContext = {
  nicheId: Id<"radarNiches">;
  fingerprint: string;
  profile: {
    businessName: string;
    description?: string;
    nicheKeywords?: string[];
    excludedKeywords?: string[];
    goal?: string;
    notes?: string;
    channels?: string[];
  };
  ads: Array<{
    id: string;
    pageName: string;
    body: string;
    activeDays: number;
    searchTerm?: string;
    destinationUrl?: string;
  }>;
  existingFresh: boolean;
  existingCreatedAt?: number;
};

/** Expand Meta Ad Library search terms for a niche (fail-soft without key). */
export const enrichNicheScrapeTerms = internalAction({
  args: {
    nicheId: v.id("radarNiches"),
    jobId: v.optional(v.id("radarNicheScrapeJobs")),
    description: v.optional(v.string()),
  },
  returns: v.object({
    ok: v.boolean(),
    terms: v.array(v.string()),
    skipped: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<EnrichResult> => {
    const niche: NicheEnrichRow | null = await ctx.runQuery(
      internal.radar.adRanking.loadNicheForEnrich,
      {
        nicheId: args.nicheId,
        jobId: args.jobId,
      },
    );
    if (!niche) {
      return { ok: false, terms: [], skipped: "niche_missing" };
    }

    const fallback: string[] = niche.scrapeTerms?.length
      ? niche.scrapeTerms
      : niche.keywords;

    // The job (if any) was created "enriching" — NOT claimable — precisely
    // so the worker can't grab it with the raw, un-expanded keyword phrase
    // before this finishes. Whatever happens below, always flip it to
    // "pending" with at least the fallback terms — a stuck "enriching" job
    // that never unlocks is worse than one scraped with weaker terms.
    if (!process.env.GEMINI_API_KEY?.trim()) {
      await ctx.runMutation(internal.radar.adRanking.applyScrapeTerms, {
        nicheId: args.nicheId,
        jobId: args.jobId,
        terms: fallback,
      });
      return { ok: false, terms: fallback, skipped: "no_gemini_key" };
    }

    try {
      const text = await callGeminiJson(
        buildScrapeTermsPrompt({
          keywords: niche.keywords,
          description: args.description,
          label: niche.label,
        }),
        {
          label: "terms",
          responseSchema: SCRAPE_TERMS_RESPONSE_SCHEMA,
          maxOutputTokens: 1024,
        },
      );
      const payload = extractJsonPayload(text) as { terms?: unknown };
      const terms = normalizeScrapeTerms(payload.terms, fallback);
      await ctx.runMutation(internal.radar.adRanking.applyScrapeTerms, {
        nicheId: args.nicheId,
        jobId: args.jobId,
        terms,
      });
      return { ok: true, terms };
    } catch (err) {
      console.warn(
        "enrichNicheScrapeTerms failed:",
        err instanceof Error ? err.message : err,
      );
      await ctx.runMutation(internal.radar.adRanking.applyScrapeTerms, {
        nicheId: args.nicheId,
        jobId: args.jobId,
        terms: fallback,
      });
      return {
        ok: false,
        terms: fallback,
        skipped: err instanceof Error ? err.message : "gemini_error",
      };
    }
  },
});

/** Rank/filter niche ads for the signed-in user. Cached ~12h. */
export const refreshMyAdRanking = action({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({
    status: v.union(
      v.literal("fresh"),
      v.literal("updated"),
      v.literal("no_user"),
      v.literal("no_niche"),
      v.literal("no_ads"),
      v.literal("no_gemini_key"),
      v.literal("error"),
    ),
    ranked: v.number(),
    dropped: v.number(),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<RankingResult> => {
    const me = await ctx.runQuery(api.users.me, {});
    if (!me) {
      return { status: "no_user", ranked: 0, dropped: 0 };
    }
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return { status: "no_gemini_key", ranked: 0, dropped: 0 };
    }

    const now = Date.now();
    const context: RankingContext | null = await ctx.runQuery(
      internal.radar.adRanking.loadRankingContext,
      { userId: me._id, now },
    );
    if (!context) {
      return { status: "no_niche", ranked: 0, dropped: 0 };
    }
    if (context.existingFresh && !args.force) {
      return {
        status: "fresh",
        ranked: context.ads.length,
        dropped: 0,
      };
    }
    // `force` bypasses the TTL/fingerprint cache above, but this is a public
    // action any signed-in client can call directly — without a floor here,
    // a caller could pass force:true in a loop and run up the Gemini bill.
    if (
      args.force &&
      context.existingCreatedAt &&
      now - context.existingCreatedAt < MIN_FORCE_REFRESH_INTERVAL_MS
    ) {
      return {
        status: "fresh",
        ranked: context.ads.length,
        dropped: 0,
        message: "cooldown",
      };
    }
    if (context.ads.length === 0) {
      return { status: "no_ads", ranked: 0, dropped: 0 };
    }

    try {
      const text = await callGeminiJson(
        buildRankingPrompt({
          profile: context.profile,
          ads: context.ads,
        }),
        {
          label: "ranking",
          responseSchema: RANKING_RESPONSE_SCHEMA,
          maxOutputTokens: 8192,
          // A thinking model judging up to MAX_ADS_TO_RANK ads with an
          // 8192-token budget routinely needs more than the 20s default —
          // that mismatch was silently failing ranking (and therefore
          // blocking the whole feed, since it's now a mandatory gate) for
          // niches with a full ad pool. Fewer attempts at a longer timeout:
          // a slow response isn't transient network noise that benefits
          // from 4 retries, it's the model actually taking a while.
          timeoutMs: 45_000,
          maxAttempts: 2,
        },
      );
      const payload = extractJsonPayload(text);
      const validIds = new Set(context.ads.map((a) => a.id));
      const parsed = parseRankingResponse(payload, validIds);

      const ranked = parsed.ranked.map((r) => ({
        adId: r.adId as Id<"radarAds">,
        score: r.score,
        reason: r.reason,
      }));
      const droppedAdIds = parsed.droppedAdIds.map(
        (id) => id as Id<"radarAds">,
      );

      await ctx.runMutation(internal.radar.adRanking.saveRanking, {
        userId: me._id,
        nicheId: context.nicheId,
        profileFingerprint: context.fingerprint,
        ranked,
        droppedAdIds,
        model: GEMINI_ADS_MODEL,
      });

      return {
        status: "updated",
        ranked: ranked.length,
        dropped: droppedAdIds.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "gemini_error";
      console.warn("refreshMyAdRanking failed:", message);
      return {
        status: "error",
        ranked: 0,
        dropped: 0,
        message,
      };
    }
  },
});

/**
 * Niche-shared relevance pass — the mandatory gate `listAdsForUser` now
 * requires before showing any ad, computed once per niche bucket instead of
 * once per (user, niche). Triggered internally (post-ingest, cron sweep,
 * migration backfill) — never called directly by a client, so no cooldown
 * guard is needed the way the public, per-user `refreshMyAdRanking` needs one.
 */
export const refreshNicheAdRelevance = internalAction({
  args: { nicheId: v.id("radarNiches"), force: v.optional(v.boolean()) },
  returns: v.object({
    status: v.union(
      v.literal("fresh"),
      v.literal("updated"),
      v.literal("no_niche"),
      v.literal("no_ads"),
      v.literal("no_gemini_key"),
      v.literal("error"),
    ),
    ranked: v.number(),
    dropped: v.number(),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<NicheRelevanceResult> => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return { status: "no_gemini_key", ranked: 0, dropped: 0 };
    }

    const now = Date.now();
    const context: NicheRelevanceContext | null = await ctx.runQuery(
      internal.radar.adRanking.loadNicheRelevanceContext,
      { nicheId: args.nicheId, now },
    );
    if (!context) {
      return { status: "no_niche", ranked: 0, dropped: 0 };
    }
    if (context.existingFresh && !args.force) {
      return { status: "fresh", ranked: context.ads.length, dropped: 0 };
    }
    if (context.ads.length === 0) {
      return { status: "no_ads", ranked: 0, dropped: 0 };
    }

    try {
      const text = await callGeminiJson(
        buildNicheRelevancePrompt({
          label: context.label,
          keywords: context.keywords,
          ads: context.ads,
        }),
        {
          label: "ranking",
          responseSchema: RANKING_RESPONSE_SCHEMA,
          maxOutputTokens: 8192,
          // A thinking model judging up to MAX_ADS_TO_RANK ads with an
          // 8192-token budget routinely needs more than the 20s default —
          // that mismatch was silently failing ranking (and therefore
          // blocking the whole feed, since it's now a mandatory gate) for
          // niches with a full ad pool. Fewer attempts at a longer timeout:
          // a slow response isn't transient network noise that benefits
          // from 4 retries, it's the model actually taking a while.
          timeoutMs: 45_000,
          maxAttempts: 2,
        },
      );
      const payload = extractJsonPayload(text);
      const validIds = new Set(context.ads.map((a) => a.id));
      const parsed = parseRankingResponse(payload, validIds);

      const ranked = parsed.ranked.map((r) => ({
        adId: r.adId as Id<"radarAds">,
        score: r.score,
        reason: r.reason,
      }));
      const droppedAdIds = parsed.droppedAdIds.map(
        (id) => id as Id<"radarAds">,
      );

      await ctx.runMutation(internal.radar.adRanking.saveNicheRelevance, {
        nicheId: args.nicheId,
        fingerprint: context.fingerprint,
        ranked,
        droppedAdIds,
        model: GEMINI_ADS_MODEL,
      });

      // Relevance changed — (re)match the niche's top-ranked ads to
      // Mercado Libre so the feed can show ML price/match inline without
      // waiting for a user to click "Investigar" on each one.
      if (ranked.length > 0) {
        await ctx.scheduler.runAfter(
          0,
          internal.radar.nicheMatching.runNicheProductMatching,
          { nicheId: args.nicheId },
        );
      }

      return {
        status: "updated",
        ranked: ranked.length,
        dropped: droppedAdIds.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "gemini_error";
      console.warn("refreshNicheAdRelevance failed:", message);
      return { status: "error", ranked: 0, dropped: 0, message };
    }
  },
});
