import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUserOrNull } from "./lib/auth";
import { TOP_N } from "./limits";
import {
  clampNicheDescription,
  computeNicheKey,
  hasNicheSignal,
  normalizeNicheKeywords,
} from "./lib/nicheProfile";

const productSnapshotValidator = v.object({
  snapshotId: v.id("trendSnapshots"),
  trendScore: v.number(),
  mlPosition: v.optional(v.number()),
  googleInterest: v.optional(v.number()),
  webBuzz: v.optional(v.number()),
  webMatchConfidence: v.optional(v.number()),
  webSources: v.optional(v.array(v.string())),
  soldQuantity: v.optional(v.number()),
  explainedBy: v.optional(v.string()),
  createdAt: v.number(),
  categoryId: v.id("categories"),
  categoryName: v.string(),
  product: v.object({
    _id: v.id("trendProducts"),
    title: v.string(),
    image: v.optional(v.string()),
    price: v.optional(v.number()),
    currency: v.optional(v.string()),
    permalink: v.optional(v.string()),
    mlId: v.string(),
  }),
});

const keywordSnapshotValidator = v.object({
  snapshotId: v.id("trendSnapshots"),
  trendScore: v.number(),
  mlBucket: v.optional(
    v.union(
      v.literal("fastest_growing"),
      v.literal("most_wanted"),
      v.literal("rising"),
    ),
  ),
  googleInterest: v.optional(v.number()),
  explainedBy: v.optional(v.string()),
  createdAt: v.number(),
  categoryId: v.id("categories"),
  categoryName: v.string(),
  keyword: v.object({
    _id: v.id("trendKeywords"),
    keyword: v.string(),
  }),
});

type ProductRow = {
  snapshotId: Id<"trendSnapshots">;
  trendScore: number;
  mlPosition?: number;
  googleInterest?: number;
  webBuzz?: number;
  webMatchConfidence?: number;
  webSources?: string[];
  soldQuantity?: number;
  explainedBy?: string;
  createdAt: number;
  categoryId: Id<"categories">;
  categoryName: string;
  product: {
    _id: Id<"trendProducts">;
    title: string;
    image?: string;
    price?: number;
    currency?: string;
    permalink?: string;
    mlId: string;
  };
};

type KeywordRow = {
  snapshotId: Id<"trendSnapshots">;
  trendScore: number;
  mlBucket?: Doc<"trendSnapshots">["mlBucket"];
  googleInterest?: number;
  explainedBy?: string;
  createdAt: number;
  categoryId: Id<"categories">;
  categoryName: string;
  keyword: {
    _id: Id<"trendKeywords">;
    keyword: string;
  };
};

async function resolveUserNicheKey(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<string | null> {
  const profile = await ctx.db
    .query("businessProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!profile) return null;

  const nicheKeywords = normalizeNicheKeywords(profile.nicheKeywords);
  const description = clampNicheDescription(profile.description);
  if (!hasNicheSignal({ keywords: nicheKeywords, description })) return null;

  const nicheKey = computeNicheKey({ keywords: nicheKeywords, description });
  return nicheKey || null;
}

export const latestRun = query({
  args: {
    siteId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      _id: v.id("trendRuns"),
      _creationTime: v.number(),
      siteId: v.string(),
      nicheKey: v.optional(v.string()),
      status: v.union(
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
      ),
      startedAt: v.number(),
      finishedAt: v.optional(v.number()),
      error: v.optional(v.string()),
      productCount: v.optional(v.number()),
      keywordCount: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    const siteId = args.siteId ?? user?.siteId ?? "MLA";
    const nicheKey = user
      ? await resolveUserNicheKey(ctx, user._id)
      : null;

    if (nicheKey) {
      const nicheRuns = await ctx.db
        .query("trendRuns")
        .withIndex("by_niche_site_started", (q) =>
          q.eq("nicheKey", nicheKey).eq("siteId", siteId),
        )
        .order("desc")
        .take(5);
      const running = nicheRuns.find((r) => r.status === "running");
      if (running) return running;
      if (nicheRuns[0]) return nicheRuns[0];
    }

    const runs = await ctx.db
      .query("trendRuns")
      .withIndex("by_site_and_started", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(5);
    const running = runs.find((r) => r.status === "running");
    if (running) return running;
    return runs[0] ?? null;
  },
});

export const productsForUser = query({
  args: {
    categoryId: v.optional(v.id("categories")),
  },
  returns: v.array(productSnapshotValidator),
  handler: async (ctx, args): Promise<ProductRow[]> => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user || !user.onboardingComplete) return [];

    const nicheKey = await resolveUserNicheKey(ctx, user._id);
    if (!nicheKey) return [];

    const links = await ctx.db
      .query("userCategories")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const categoryIds = links
      .map((l) => l.categoryId)
      .filter((id) => (args.categoryId ? id === args.categoryId : true));

    const results: ProductRow[] = [];

    for (const categoryId of categoryIds) {
      const category = await ctx.db.get(categoryId);
      if (!category) continue;

      const snapshots = await ctx.db
        .query("trendSnapshots")
        .withIndex("by_niche_category_site", (q) =>
          q
            .eq("nicheKey", nicheKey)
            .eq("categoryId", categoryId)
            .eq("siteId", user.siteId),
        )
        .order("desc")
        .take(80);

      const latestByProduct = new Map<string, (typeof snapshots)[number]>();
      for (const snap of snapshots) {
        if (snap.entityType !== "product" || !snap.productId) continue;
        if (!latestByProduct.has(snap.productId)) {
          latestByProduct.set(snap.productId, snap);
        }
      }

      for (const snap of latestByProduct.values()) {
        if (!snap.productId) continue;
        const product = await ctx.db.get(snap.productId);
        if (!product) continue;
        results.push({
          snapshotId: snap._id,
          trendScore: snap.trendScore,
          mlPosition: snap.mlPosition,
          googleInterest: snap.googleInterest,
          webBuzz: snap.webBuzz,
          webMatchConfidence: snap.webMatchConfidence,
          webSources: snap.webSources,
          soldQuantity: snap.soldQuantity,
          explainedBy: snap.explainedBy,
          createdAt: snap.createdAt,
          categoryId,
          categoryName: category.name,
          product: {
            _id: product._id,
            title: product.title,
            image: product.image,
            price: product.price,
            currency: product.currency,
            permalink: product.permalink,
            mlId: product.mlId,
          },
        });
      }
    }

    results.sort((a, b) => b.trendScore - a.trendScore);
    return results.slice(0, TOP_N);
  },
});

export const keywordsForUser = query({
  args: {
    categoryId: v.optional(v.id("categories")),
  },
  returns: v.array(keywordSnapshotValidator),
  handler: async (ctx, args): Promise<KeywordRow[]> => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user || !user.onboardingComplete) return [];

    const nicheKey = await resolveUserNicheKey(ctx, user._id);
    if (!nicheKey) return [];

    const links = await ctx.db
      .query("userCategories")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const categoryIds = links
      .map((l) => l.categoryId)
      .filter((id) => (args.categoryId ? id === args.categoryId : true));

    const results: KeywordRow[] = [];

    for (const categoryId of categoryIds) {
      const category = await ctx.db.get(categoryId);
      if (!category) continue;

      const snapshots = await ctx.db
        .query("trendSnapshots")
        .withIndex("by_niche_category_site", (q) =>
          q
            .eq("nicheKey", nicheKey)
            .eq("categoryId", categoryId)
            .eq("siteId", user.siteId),
        )
        .order("desc")
        .take(80);

      const latestByKeyword = new Map<string, (typeof snapshots)[number]>();
      for (const snap of snapshots) {
        if (snap.entityType !== "keyword" || !snap.keywordId) continue;
        if (!latestByKeyword.has(snap.keywordId)) {
          latestByKeyword.set(snap.keywordId, snap);
        }
      }

      for (const snap of latestByKeyword.values()) {
        if (!snap.keywordId) continue;
        const keyword = await ctx.db.get(snap.keywordId);
        if (!keyword) continue;
        results.push({
          snapshotId: snap._id,
          trendScore: snap.trendScore,
          mlBucket: snap.mlBucket,
          googleInterest: snap.googleInterest,
          explainedBy: snap.explainedBy,
          createdAt: snap.createdAt,
          categoryId,
          categoryName: category.name,
          keyword: {
            _id: keyword._id,
            keyword: keyword.keyword,
          },
        });
      }
    }

    results.sort((a, b) => b.trendScore - a.trendScore);
    return results.slice(0, TOP_N);
  },
});
