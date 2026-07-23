import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  computeTrendScore,
  explainScoreBreakdown,
  formatScoreBreakdownLog,
  WEB_MATCH_MIN_CONFIDENCE,
  type MlBucket,
} from "./scoring";
import { MAX_NICHES_PER_CRON, TOP_N } from "./limits";
import { linkWebToMlCatalog, webProductKey } from "./productMatch";
import {
  clampNicheDescription,
  computeNicheKey,
  hasNicheSignal,
  normalizeNicheKeywords,
  passesNicheFilter,
  type NicheInput,
} from "./lib/nicheProfile";
import {
  interestFromNicheTrends,
  type NicheTrendsResult,
} from "./googleTrends";
import { getCurrentUserOrNull } from "./lib/auth";

export const startRun = internalMutation({
  args: {
    siteId: v.string(),
    nicheKey: v.string(),
  },
  returns: v.id("trendRuns"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("trendRuns", {
      siteId: args.siteId,
      nicheKey: args.nicheKey,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("trendRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    productCount: v.optional(v.number()),
    keywordCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
      finishedAt: Date.now(),
      error: args.error,
      productCount: args.productCount,
      keywordCount: args.keywordCount,
    });
    return null;
  },
});

const categoryRowValidator = v.object({
  _id: v.id("categories"),
  name: v.string(),
  mlCategoryId: v.string(),
});

export const listCategoriesByIds = internalQuery({
  args: {
    siteId: v.string(),
    categoryIds: v.array(v.id("categories")),
  },
  returns: v.array(categoryRowValidator),
  handler: async (ctx, args) => {
    const result: Array<{
      _id: Id<"categories">;
      name: string;
      mlCategoryId: string;
    }> = [];

    for (const id of args.categoryIds) {
      const cat = await ctx.db.get(id);
      if (!cat) continue;
      const mlCategoryId =
        cat.mlCategoryIds[args.siteId as keyof typeof cat.mlCategoryIds];
      if (!mlCategoryId) continue;
      result.push({
        _id: cat._id,
        name: cat.name,
        mlCategoryId,
      });
    }
    return result;
  },
});

const activeNicheValidator = v.object({
  nicheKey: v.string(),
  siteId: v.string(),
  nicheKeywords: v.array(v.string()),
  description: v.optional(v.string()),
  categoryIds: v.array(v.id("categories")),
});

/** Distinct active niches from onboarded users (shared cache key). */
export const listActiveNiches = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(activeNicheValidator),
  handler: async (ctx, args) => {
    const limit = args.limit ?? MAX_NICHES_PER_CRON;
    const profiles = await ctx.db.query("businessProfiles").collect();
    const byKey = new Map<
      string,
      {
        nicheKey: string;
        siteId: string;
        nicheKeywords: string[];
        description?: string;
        categoryIds: Set<Id<"categories">>;
      }
    >();

    for (const profile of profiles) {
      const user = await ctx.db.get(profile.userId);
      if (!user?.onboardingComplete) continue;

      const nicheKeywords = normalizeNicheKeywords(profile.nicheKeywords);
      const description = clampNicheDescription(profile.description);
      if (!hasNicheSignal({ keywords: nicheKeywords, description })) continue;

      const nicheKey = computeNicheKey({ keywords: nicheKeywords, description });
      if (!nicheKey) continue;

      const links = await ctx.db
        .query("userCategories")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();

      const existing = byKey.get(`${nicheKey}:${user.siteId}`);
      if (existing) {
        for (const link of links) existing.categoryIds.add(link.categoryId);
        continue;
      }

      byKey.set(`${nicheKey}:${user.siteId}`, {
        nicheKey,
        siteId: user.siteId,
        nicheKeywords,
        description,
        categoryIds: new Set(links.map((l) => l.categoryId)),
      });
    }

    return [...byKey.values()]
      .slice(0, limit)
      .map((n) => ({
        nicheKey: n.nicheKey,
        siteId: n.siteId,
        nicheKeywords: n.nicheKeywords,
        description: n.description,
        categoryIds: [...n.categoryIds],
      }));
  },
});

export const getUserNicheContext = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.object({
      siteId: v.string(),
      nicheKey: v.string(),
      nicheKeywords: v.array(v.string()),
      description: v.optional(v.string()),
      categoryIds: v.array(v.id("categories")),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user?.onboardingComplete) return null;

    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile) return null;

    const nicheKeywords = normalizeNicheKeywords(profile.nicheKeywords);
    const description = clampNicheDescription(profile.description);
    if (!hasNicheSignal({ keywords: nicheKeywords, description })) return null;

    const nicheKey = computeNicheKey({ keywords: nicheKeywords, description });
    if (!nicheKey) return null;

    const links = await ctx.db
      .query("userCategories")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    return {
      siteId: user.siteId,
      nicheKey,
      nicheKeywords,
      description,
      categoryIds: links.map((l) => l.categoryId),
    };
  },
});

export const getPreviousProductScore = internalQuery({
  args: {
    productId: v.id("trendProducts"),
  },
  returns: v.union(
    v.object({
      trendScore: v.number(),
      mlPosition: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const snaps = await ctx.db
      .query("trendSnapshots")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .order("desc")
      .take(1);
    const snap = snaps[0];
    if (!snap) return null;
    return {
      trendScore: snap.trendScore,
      mlPosition: snap.mlPosition,
    };
  },
});

export const upsertProductSnapshot = internalMutation({
  args: {
    runId: v.id("trendRuns"),
    nicheKey: v.string(),
    categoryId: v.id("categories"),
    siteId: v.string(),
    mlId: v.string(),
    mlType: v.union(
      v.literal("ITEM"),
      v.literal("PRODUCT"),
      v.literal("USER_PRODUCT"),
      v.literal("WEB"),
    ),
    title: v.string(),
    image: v.optional(v.string()),
    price: v.optional(v.number()),
    currency: v.optional(v.string()),
    permalink: v.optional(v.string()),
    soldQuantity: v.optional(v.number()),
    mlPosition: v.optional(v.number()),
    googleInterest: v.optional(v.number()),
    webBuzz: v.optional(v.number()),
    webMatchConfidence: v.optional(v.number()),
    webSources: v.optional(v.array(v.string())),
    explainedBy: v.optional(v.string()),
    previousScore: v.optional(v.number()),
    previousPosition: v.optional(v.number()),
  },
  returns: v.id("trendSnapshots"),
  handler: async (ctx, args) => {
    const canonicalKey = `${args.siteId}:${args.mlId}`;
    const existing = await ctx.db
      .query("trendProducts")
      .withIndex("by_canonical", (q) => q.eq("canonicalKey", canonicalKey))
      .unique();

    const productFields = {
      canonicalKey,
      title: args.title,
      image: args.image,
      price: args.price,
      currency: args.currency,
      mlId: args.mlId,
      mlType: args.mlType,
      permalink: args.permalink,
      categoryId: args.categoryId,
      siteId: args.siteId,
      soldQuantity: args.soldQuantity,
      updatedAt: Date.now(),
    };

    let productId: Id<"trendProducts">;
    if (existing) {
      await ctx.db.patch(existing._id, productFields);
      productId = existing._id;
    } else {
      productId = await ctx.db.insert("trendProducts", productFields);
    }

    const trendScore = computeTrendScore({
      mlPosition: args.mlPosition,
      googleInterest: args.googleInterest,
      webBuzz: args.webBuzz,
      previousScore: args.previousScore,
      previousPosition: args.previousPosition,
    });

    return await ctx.db.insert("trendSnapshots", {
      runId: args.runId,
      entityType: "product",
      productId,
      categoryId: args.categoryId,
      siteId: args.siteId,
      nicheKey: args.nicheKey,
      trendScore,
      mlPosition: args.mlPosition,
      googleInterest: args.googleInterest,
      webBuzz: args.webBuzz,
      webMatchConfidence: args.webMatchConfidence,
      webSources: args.webSources,
      soldQuantity: args.soldQuantity,
      explainedBy: args.explainedBy,
      createdAt: Date.now(),
    });
  },
});

export const upsertKeywordSnapshot = internalMutation({
  args: {
    runId: v.id("trendRuns"),
    nicheKey: v.string(),
    categoryId: v.id("categories"),
    siteId: v.string(),
    keyword: v.string(),
    mlBucket: v.union(
      v.literal("fastest_growing"),
      v.literal("most_wanted"),
      v.literal("rising"),
    ),
    googleInterest: v.optional(v.number()),
    explainedBy: v.optional(v.string()),
  },
  returns: v.id("trendSnapshots"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("trendKeywords")
      .withIndex("by_keyword_category_site", (q) =>
        q
          .eq("keyword", args.keyword)
          .eq("categoryId", args.categoryId)
          .eq("siteId", args.siteId),
      )
      .unique();

    let keywordId: Id<"trendKeywords">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        mlBucket: args.mlBucket,
        updatedAt: Date.now(),
      });
      keywordId = existing._id;
    } else {
      keywordId = await ctx.db.insert("trendKeywords", {
        keyword: args.keyword,
        categoryId: args.categoryId,
        siteId: args.siteId,
        mlBucket: args.mlBucket,
        updatedAt: Date.now(),
      });
    }

    const trendScore = computeTrendScore({
      mlBucket: args.mlBucket as MlBucket,
      googleInterest: args.googleInterest,
    });

    return await ctx.db.insert("trendSnapshots", {
      runId: args.runId,
      entityType: "keyword",
      keywordId,
      categoryId: args.categoryId,
      siteId: args.siteId,
      nicheKey: args.nicheKey,
      trendScore,
      mlBucket: args.mlBucket,
      googleInterest: args.googleInterest,
      explainedBy: args.explainedBy,
      createdAt: Date.now(),
    });
  },
});

export const findProductByMlId = internalQuery({
  args: { mlId: v.string() },
  returns: v.union(v.id("trendProducts"), v.null()),
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("trendProducts")
      .withIndex("by_ml_id", (q) => q.eq("mlId", args.mlId))
      .unique();
    return product?._id ?? null;
  },
});

type UnifiedRow = {
  mlId: string;
  mlType: "ITEM" | "PRODUCT" | "USER_PRODUCT" | "WEB";
  title: string;
  image?: string;
  price?: number;
  currency?: string;
  permalink?: string;
  soldQuantity?: number;
  mlPosition?: number;
  webBuzz?: number;
  webMatchConfidence?: number;
  webSources?: string[];
  explainedBy?: string;
  fromWebDiscovery: boolean;
  crossSignals?: string[];
};

/**
 * Collect Trends + ML evidence → Gemini crosses & decides → enrich listings.
 * Not a funnel: sources are peers; Gemini arbitrates disagreements.
 */
async function ingestNicheCategory(
  ctx: ActionCtx,
  args: {
    runId: Id<"trendRuns">;
    siteId: string;
    nicheKey: string;
    niche: NicheInput;
    category: { _id: Id<"categories">; name: string; mlCategoryId: string };
  },
): Promise<{ productCount: number; keywordCount: number }> {
  const { runId, siteId, nicheKey, niche, category } = args;
  let productCount = 0;
  let keywordCount = 0;

  // 1) Collect evidence in parallel (independent signals)
  const [nicheTrends, payload] = await Promise.all([
    ctx.runAction(internal.googleTrends.fetchNicheTrends, {
      siteId,
      nicheKeywords: niche.keywords,
      businessDescription: niche.description,
    }),
    ctx.runAction(internal.ml.fetchCategoryTrends, {
      siteId,
      mlCategoryId: category.mlCategoryId,
    }),
  ]);

  const mlProductsForGemini = payload.enriched
    .filter((item) => passesNicheFilter(item.title, niche))
    .slice(0, 12)
    .map((item) => ({
      title: item.title,
      position: item.position,
      price: item.price,
    }));

  const mlKeywordsForGemini = payload.keywords
    .filter((kw) => passesNicheFilter(kw.keyword, niche))
    .slice(0, 10)
    .map((kw) => ({ keyword: kw.keyword, bucket: kw.bucket }));

  console.log(
    `[cross] evidence niche=${nicheKey} cat="${category.name}" trends=${nicheTrends.related.length}(${nicheTrends.source}) mlProducts=${mlProductsForGemini.length}/${payload.enriched.length} mlKw=${mlKeywordsForGemini.length}`,
  );

  // 2) Gemini crosses signals and decides recommendations
  const decision = await ctx.runAction(internal.gemini.discoverWebTrends, {
    categoryName: category.name,
    siteId,
    nicheKeywords: niche.keywords,
    businessDescription: niche.description,
    trendsSeed: nicheTrends.seedQuery,
    trendsRelated: nicheTrends.related.map((r) => ({
      query: r.query,
      kind: r.kind,
      interest: r.interest,
    })),
    mlProducts: mlProductsForGemini,
    mlKeywords: mlKeywordsForGemini,
  });

  console.log(
    `[cross] gemini decided=${decision.products.length} notes=${decision.searchNotes}`,
  );

  // 3) Enrich decided products with ML listings (catalog match or search)
  const linkedWeb = linkWebToMlCatalog(
    decision.products,
    payload.enriched.map((item) => ({
      mlId: item.mlId,
      title: item.title,
      position: item.position,
    })),
    WEB_MATCH_MIN_CONFIDENCE,
  );

  const unified: UnifiedRow[] = [];

  for (const w of linkedWeb) {
    const mlItem = w.mlId
      ? payload.enriched.find((e) => e.mlId === w.mlId)
      : undefined;
    const linked =
      mlItem !== undefined && w.matchConfidence >= WEB_MATCH_MIN_CONFIDENCE;
    const useCatalog =
      linked && mlItem && passesNicheFilter(mlItem.title, niche);

    let searched: {
      mlId: string;
      mlType: "ITEM" | "PRODUCT" | "USER_PRODUCT";
      title: string;
      image?: string;
      price?: number;
      currency?: string;
      permalink?: string;
      soldQuantity?: number;
    } | null = null;
    if (!useCatalog) {
      searched = await ctx.runAction(internal.ml.searchProduct, {
        siteId,
        query: w.webProductName,
      });
      if (searched && !passesNicheFilter(searched.title, niche)) {
        searched = null;
      }
    }

    const finalTitle =
      useCatalog && mlItem
        ? mlItem.title
        : searched
          ? searched.title
          : w.webProductName;

    unified.push({
      mlId:
        useCatalog && mlItem
          ? mlItem.mlId
          : searched
            ? searched.mlId
            : webProductKey(w.webProductName),
      mlType:
        useCatalog && mlItem
          ? mlItem.mlType
          : searched
            ? searched.mlType
            : "WEB",
      title: finalTitle,
      image: useCatalog ? mlItem?.image : searched?.image,
      price: useCatalog ? mlItem?.price : searched?.price,
      currency: useCatalog ? mlItem?.currency : searched?.currency,
      permalink: useCatalog ? mlItem?.permalink : searched?.permalink,
      soldQuantity: useCatalog
        ? mlItem?.soldQuantity
        : searched?.soldQuantity,
      mlPosition:
        useCatalog && mlItem
          ? mlItem.position
          : searched
            ? 12
            : undefined,
      webBuzz: w.webBuzz,
      webMatchConfidence: useCatalog
        ? w.matchConfidence
        : searched
          ? 0.6
          : w.matchConfidence,
      webSources: w.sources,
      explainedBy: w.rationale || undefined,
      fromWebDiscovery: true,
      crossSignals: w.signals,
    });
  }

  const capped = unified
    .sort((a, b) => (b.webBuzz ?? 0) - (a.webBuzz ?? 0))
    .slice(0, TOP_N);

  const trendsBundle: NicheTrendsResult = nicheTrends;

  for (const row of capped) {
    const existingProduct = await ctx.runQuery(
      internal.ingestion.findProductByMlId,
      { mlId: row.mlId },
    );
    let previousScore: number | undefined;
    let previousPosition: number | undefined;
    if (existingProduct) {
      const prev = await ctx.runQuery(
        internal.ingestion.getPreviousProductScore,
        { productId: existingProduct },
      );
      previousScore = prev?.trendScore;
      previousPosition = prev?.mlPosition;
    }

    // Interest from the single niche Trends bundle — no per-product SerpAPI
    const googleInterest = interestFromNicheTrends(row.title, trendsBundle);

    const productSignals = {
      mlPosition: row.mlPosition,
      googleInterest,
      webBuzz: row.webBuzz,
      previousScore,
      previousPosition,
    };
    console.log(
      formatScoreBreakdownLog(
        row.title,
        {
          categoryName: category.name,
          siteId,
          id: row.mlId,
        },
        explainScoreBreakdown(productSignals, {
          rawWebBuzz: row.webBuzz,
          confidence: row.webMatchConfidence,
          webProductName: row.fromWebDiscovery ? row.title : undefined,
          sources: row.webSources,
          rationale: [
            row.explainedBy,
            row.crossSignals?.length
              ? `cruzó: ${row.crossSignals.join("+")}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          fromWebDiscovery: row.fromWebDiscovery,
        }),
      ),
    );

    const explainedBy =
      row.explainedBy ??
      (row.crossSignals?.length
        ? `Sugerido cruzando ${row.crossSignals.join(" + ")}.`
        : undefined);

    await ctx.runMutation(internal.ingestion.upsertProductSnapshot, {
      runId,
      nicheKey,
      categoryId: category._id,
      siteId,
      mlId: row.mlId,
      mlType: row.mlType,
      title: row.title,
      image: row.image,
      price: row.price,
      currency: row.currency,
      permalink: row.permalink,
      soldQuantity: row.soldQuantity,
      mlPosition: row.mlPosition,
      googleInterest,
      webBuzz: row.webBuzz,
      webMatchConfidence: row.webMatchConfidence,
      webSources: row.webSources,
      explainedBy,
      previousScore,
      previousPosition,
    });
    productCount += 1;
  }

  // Keywords: Trends related (primary) + niche-filtered ML keywords — no SerpAPI per kw
  type KwRow = {
    keyword: string;
    mlBucket: MlBucket;
    googleInterest: number;
  };
  const kwMap = new Map<string, KwRow>();

  for (const rel of nicheTrends.related) {
    const key = rel.query.trim().toLowerCase();
    if (!key || !passesNicheFilter(rel.query, niche)) continue;
    kwMap.set(key, {
      keyword: rel.query,
      mlBucket: rel.kind === "rising" ? "fastest_growing" : "most_wanted",
      googleInterest: rel.interest,
    });
  }
  for (const kw of payload.keywords) {
    if (!passesNicheFilter(kw.keyword, niche)) continue;
    const key = kw.keyword.trim().toLowerCase();
    if (kwMap.has(key)) continue;
    kwMap.set(key, {
      keyword: kw.keyword,
      mlBucket: kw.bucket,
      googleInterest: interestFromNicheTrends(kw.keyword, trendsBundle),
    });
  }

  const keywordRows = [...kwMap.values()]
    .sort((a, b) => b.googleInterest - a.googleInterest)
    .slice(0, TOP_N);

  for (const [index, kw] of keywordRows.entries()) {
    const keywordSignals = {
      mlBucket: kw.mlBucket,
      googleInterest: kw.googleInterest,
    };
    const provisionalScore = computeTrendScore(keywordSignals);
    console.log(
      formatScoreBreakdownLog(
        kw.keyword,
        {
          categoryName: category.name,
          siteId,
        },
        explainScoreBreakdown(keywordSignals),
      ),
    );

    let explainedBy: string | undefined;
    if (index < 2) {
      explainedBy = await ctx.runAction(internal.gemini.explainTrend, {
        title: kw.keyword,
        entityType: "keyword",
        categoryName: category.name,
        trendScore: provisionalScore,
        mlBucket: kw.mlBucket,
        googleInterest: kw.googleInterest,
        siteId,
      });
    }

    await ctx.runMutation(internal.ingestion.upsertKeywordSnapshot, {
      runId,
      nicheKey,
      categoryId: category._id,
      siteId,
      keyword: kw.keyword,
      mlBucket: kw.mlBucket,
      googleInterest: kw.googleInterest,
      explainedBy,
    });
    keywordCount += 1;
  }

  return { productCount, keywordCount };
}

/** Niche-scoped research for one fingerprint + categories. */
export const runNiche = internalAction({
  args: {
    siteId: v.string(),
    nicheKey: v.string(),
    nicheKeywords: v.array(v.string()),
    description: v.optional(v.string()),
    categoryIds: v.array(v.id("categories")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const nicheKeywords = normalizeNicheKeywords(args.nicheKeywords);
    const description = clampNicheDescription(args.description);
    const niche: NicheInput = { keywords: nicheKeywords, description };
    if (!hasNicheSignal(niche) || !args.nicheKey) {
      console.warn("[ingest] runNiche skipped: empty niche");
      return null;
    }

    await ctx.runMutation(internal.categories.seedInternal, {});
    const runId = await ctx.runMutation(internal.ingestion.startRun, {
      siteId: args.siteId,
      nicheKey: args.nicheKey,
    });

    let productCount = 0;
    let keywordCount = 0;

    try {
      const categories = await ctx.runQuery(
        internal.ingestion.listCategoriesByIds,
        {
          siteId: args.siteId,
          categoryIds: args.categoryIds,
        },
      );

      for (const category of categories) {
        const counts = await ingestNicheCategory(ctx, {
          runId,
          siteId: args.siteId,
          nicheKey: args.nicheKey,
          niche,
          category,
        });
        productCount += counts.productCount;
        keywordCount += counts.keywordCount;
      }

      await ctx.runMutation(internal.ingestion.finishRun, {
        runId,
        status: "completed",
        productCount,
        keywordCount,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown ingestion error";
      await ctx.runMutation(internal.ingestion.finishRun, {
        runId,
        status: "failed",
        error: message,
        productCount,
        keywordCount,
      });
      throw error;
    }

    return null;
  },
});

export const runNicheForUser = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const nicheCtx = await ctx.runQuery(internal.ingestion.getUserNicheContext, {
      userId: args.userId,
    });
    if (!nicheCtx || nicheCtx.categoryIds.length === 0) {
      console.warn("[ingest] runNicheForUser: no niche context", args.userId);
      return null;
    }

    await ctx.runAction(internal.ingestion.runNiche, {
      siteId: nicheCtx.siteId,
      nicheKey: nicheCtx.nicheKey,
      nicheKeywords: nicheCtx.nicheKeywords,
      description: nicheCtx.description,
      categoryIds: nicheCtx.categoryIds,
    });
    return null;
  },
});

/** Cron / shared refresh: distinct active niches only (capped). */
export const runActiveNiches = internalAction({
  args: {
    siteId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.categories.seedInternal, {});
    const niches = await ctx.runQuery(internal.ingestion.listActiveNiches, {
      limit: args.limit ?? MAX_NICHES_PER_CRON,
    });

    const filtered = args.siteId
      ? niches.filter((n) => n.siteId === args.siteId)
      : niches;

    console.log(`[ingest] runActiveNiches count=${filtered.length}`);

    for (const niche of filtered) {
      if (niche.categoryIds.length === 0) continue;
      try {
        await ctx.runAction(internal.ingestion.runNiche, {
          siteId: niche.siteId,
          nicheKey: niche.nicheKey,
          nicheKeywords: niche.nicheKeywords,
          description: niche.description,
          categoryIds: niche.categoryIds,
        });
      } catch (error) {
        console.error(
          `[ingest] niche ${niche.nicheKey} failed`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return null;
  },
});

/** @deprecated Prefer runActiveNiches / runNiche. Kept for CLI compatibility. */
export const runAll = internalAction({
  args: {
    siteId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runAction(internal.ingestion.runActiveNiches, {
      siteId: args.siteId,
    });
    return null;
  },
});

/** Manual trigger from UI — research for the authenticated user's niche. */
export const triggerIngestion = mutation({
  args: {
    siteId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");
    if (!user.onboardingComplete) {
      throw new Error("Completá el onboarding primero");
    }

    if (args.siteId && args.siteId !== user.siteId) {
      await ctx.db.patch(user._id, { siteId: args.siteId });
    }

    await ctx.scheduler.runAfter(0, internal.ingestion.runNicheForUser, {
      userId: user._id,
    });
    return null;
  },
});
