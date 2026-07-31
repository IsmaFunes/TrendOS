"use node";

/**
 * Gemini personalization: scrape-term expansion + per-user ad ranking.
 */

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  buildRankingPrompt,
  buildScrapeTermsPrompt,
  extractJsonPayload,
  GEMINI_ADS_MODEL,
  normalizeScrapeTerms,
  parseRankingResponse,
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

async function callGeminiJson(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_ADS_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GeminiGenerateResponse;
  const text = extractText(json);
  if (!text) {
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
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return { ok: false, terms: [], skipped: "no_gemini_key" };
    }

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

    try {
      const text = await callGeminiJson(
        buildScrapeTermsPrompt({
          keywords: niche.keywords,
          description: args.description,
          label: niche.label,
        }),
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
    if (context.ads.length === 0) {
      return { status: "no_ads", ranked: 0, dropped: 0 };
    }

    try {
      const text = await callGeminiJson(
        buildRankingPrompt({
          profile: context.profile,
          ads: context.ads,
        }),
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
