import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    siteId: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro")),
    refreshIntervalHours: v.number(),
    onboardingComplete: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_clerk", ["clerkId"]),

  businessProfiles: defineTable({
    userId: v.id("users"),
    businessName: v.string(),
    description: v.optional(v.string()),
    nicheKeywords: v.optional(v.array(v.string())),
    channels: v.optional(v.array(v.string())),
    monthlyRevenueRange: v.optional(v.string()),
    targetMarginPercent: v.optional(v.number()),
    notes: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  categories: defineTable({
    slug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    mlCategoryIds: v.object({
      MLA: v.optional(v.string()),
      MLB: v.optional(v.string()),
      MLM: v.optional(v.string()),
      MLC: v.optional(v.string()),
      MCO: v.optional(v.string()),
    }),
  }).index("by_slug", ["slug"]),

  userCategories: defineTable({
    userId: v.id("users"),
    categoryId: v.id("categories"),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_category", ["userId", "categoryId"])
    .index("by_category", ["categoryId"]),

  trendRuns: defineTable({
    siteId: v.string(),
    /** Fingerprint of store niche; missing/"" = legacy baseline. Always set on new runs. */
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
  })
    .index("by_site", ["siteId"])
    .index("by_site_and_started", ["siteId", "startedAt"])
    .index("by_niche_site_started", ["nicheKey", "siteId", "startedAt"]),

  trendProducts: defineTable({
    canonicalKey: v.string(),
    title: v.string(),
    image: v.optional(v.string()),
    price: v.optional(v.number()),
    currency: v.optional(v.string()),
    mlId: v.string(),
    mlType: v.union(
      v.literal("ITEM"),
      v.literal("PRODUCT"),
      v.literal("USER_PRODUCT"),
      v.literal("WEB"),
    ),
    permalink: v.optional(v.string()),
    categoryId: v.id("categories"),
    siteId: v.string(),
    soldQuantity: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_canonical", ["canonicalKey"])
    .index("by_category_and_site", ["categoryId", "siteId"])
    .index("by_ml_id", ["mlId"]),

  trendKeywords: defineTable({
    keyword: v.string(),
    categoryId: v.id("categories"),
    siteId: v.string(),
    mlBucket: v.optional(
      v.union(
        v.literal("fastest_growing"),
        v.literal("most_wanted"),
        v.literal("rising"),
      ),
    ),
    updatedAt: v.number(),
  })
    .index("by_keyword_category_site", ["keyword", "categoryId", "siteId"])
    .index("by_category_and_site", ["categoryId", "siteId"]),

  trendSnapshots: defineTable({
    runId: v.id("trendRuns"),
    entityType: v.union(v.literal("product"), v.literal("keyword")),
    productId: v.optional(v.id("trendProducts")),
    keywordId: v.optional(v.id("trendKeywords")),
    categoryId: v.id("categories"),
    siteId: v.string(),
    /** Same fingerprint as trendRuns.nicheKey for niche-scoped research. */
    nicheKey: v.optional(v.string()),
    trendScore: v.number(),
    mlPosition: v.optional(v.number()),
    mlBucket: v.optional(
      v.union(
        v.literal("fastest_growing"),
        v.literal("most_wanted"),
        v.literal("rising"),
      ),
    ),
    googleInterest: v.optional(v.number()),
    webBuzz: v.optional(v.number()),
    webMatchConfidence: v.optional(v.number()),
    webSources: v.optional(v.array(v.string())),
    soldQuantity: v.optional(v.number()),
    explainedBy: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_category_and_site", ["categoryId", "siteId"])
    .index("by_niche_category_site", ["nicheKey", "categoryId", "siteId"])
    .index("by_category_score", ["categoryId", "trendScore"])
    .index("by_product", ["productId"])
    .index("by_keyword", ["keywordId"]),
});
