"use node";

/**
 * Gemini personalization: one-time niche term localization (seed time) +
 * the niche-shared ad relevance pass.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fetchJsonWithRetry, structuredLog } from "./http";
import {
  buildNicheRelevancePrompt,
  buildNicheTermLocalizationPrompt,
  extractJsonPayload,
  GEMINI_ADS_MODEL,
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
        // longer/more-reasoning-heavy prompt can spend the whole budget
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

type NicheRelevanceContext = {
  fingerprint: string;
  label: string;
  gateTerms: string[];
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

/**
 * One-time, seed-time term localization — translates/adapts a niche's
 * hand-curated AR-Spanish base terms into another country's ad-library
 * language. Called only from convex/admin/seedNicheCatalog.ts, never per
 * scrape (niches are a fixed catalog, terms don't change on their own).
 */
export const localizeNicheTerms = internalAction({
  args: {
    label: v.string(),
    description: v.optional(v.string()),
    baseTerms: v.array(v.string()),
    targetCountry: v.string(),
    targetLanguage: v.string(),
  },
  returns: v.object({ ok: v.boolean(), terms: v.array(v.string()) }),
  handler: async (_ctx, args) => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return { ok: false, terms: args.baseTerms };
    }
    try {
      const text = await callGeminiJson(
        buildNicheTermLocalizationPrompt({
          label: args.label,
          description: args.description,
          baseTerms: args.baseTerms,
          targetCountry: args.targetCountry,
          targetLanguage: args.targetLanguage,
        }),
        {
          label: "terms",
          responseSchema: SCRAPE_TERMS_RESPONSE_SCHEMA,
          maxOutputTokens: 1024,
        },
      );
      const payload = extractJsonPayload(text) as { terms?: unknown };
      const terms = normalizeScrapeTerms(payload.terms, args.baseTerms);
      return { ok: true, terms };
    } catch (err) {
      console.warn(
        "localizeNicheTerms failed:",
        err instanceof Error ? err.message : err,
      );
      return { ok: false, terms: args.baseTerms };
    }
  },
});

/**
 * Niche-shared relevance pass — the mandatory gate `listAdsForUser` now
 * requires before showing any ad, computed once per niche bucket. Triggered
 * internally (post-ingest, cron sweep, migration backfill) — never called
 * directly by a client, so no per-caller cooldown guard is needed.
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
          keywords: context.gateTerms,
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

      // ML matching runs on-demand only, when a user clicks "Investigar" on
      // a specific ad (convex/radar/investigate.ts investigateAd) — never
      // automatically here. Browsing the feed stays cheap and fast;
      // per-product ML/supplier research is a deliberate action, not
      // implicit background work.

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
