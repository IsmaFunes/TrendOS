import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireCurrentUser } from "../lib/auth";
import { normalizeAlias } from "./normalize";
import { dataSourceValidator } from "./validators";
import { normalizeWholesaleOffer } from "./providers/wholesale";
import { periodKeyFromTs } from "./metrics";

export const listSearchTerms = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("radarSearchTerms"),
      term: v.string(),
      normalizedTerm: v.string(),
      country: v.string(),
      isActive: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    await requireCurrentUser(ctx);
    const terms = await ctx.db.query("radarSearchTerms").collect();
    return terms.map((t) => ({
      _id: t._id,
      term: t.term,
      normalizedTerm: t.normalizedTerm,
      country: t.country,
      isActive: t.isActive,
    }));
  },
});

export const addSearchTerm = mutation({
  args: {
    term: v.string(),
    country: v.optional(v.string()),
    categoryId: v.optional(v.id("categories")),
  },
  returns: v.id("radarSearchTerms"),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const term = args.term.trim();
    if (!term) throw new Error("term required");
    const country = args.country ?? "AR";
    const normalizedTerm = normalizeAlias(term);
    const existing = await ctx.db
      .query("radarSearchTerms")
      .withIndex("by_normalized_country", (q) =>
        q.eq("normalizedTerm", normalizedTerm).eq("country", country),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        isActive: true,
        updatedAt: Date.now(),
        categoryId: args.categoryId ?? existing.categoryId,
      });
      return existing._id;
    }
    return await ctx.db.insert("radarSearchTerms", {
      term,
      normalizedTerm,
      country,
      categoryId: args.categoryId,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const setSearchTermActive = mutation({
  args: {
    searchTermId: v.id("radarSearchTerms"),
    isActive: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    await ctx.db.patch(args.searchTermId, {
      isActive: args.isActive,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const importWholesaleOffers = mutation({
  args: {
    offers: v.array(
      v.object({
        sku: v.string(),
        title: v.string(),
        supplierName: v.optional(v.string()),
        currency: v.optional(v.string()),
        unitPrice: v.number(),
        moq: v.optional(v.number()),
        leadTimeDays: v.optional(v.number()),
        externalUrl: v.optional(v.string()),
        aliases: v.optional(v.array(v.string())),
        productId: v.optional(v.id("radarProducts")),
      }),
    ),
  },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    let upserted = 0;
    const now = Date.now();
    for (const raw of args.offers) {
      const offer = normalizeWholesaleOffer(raw);
      const existing = await ctx.db
        .query("radarWholesaleOffers")
        .withIndex("by_sku", (q) => q.eq("sku", offer.sku))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          ...offer,
          productId: raw.productId ?? existing.productId,
          isActive: true,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("radarWholesaleOffers", {
          ...offer,
          productId: raw.productId,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
      }
      upserted += 1;
    }
    return { upserted };
  },
});

export const listWholesaleOffers = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("radarWholesaleOffers"),
      sku: v.string(),
      title: v.string(),
      unitPrice: v.number(),
      currency: v.string(),
      moq: v.optional(v.number()),
      leadTimeDays: v.optional(v.number()),
      productId: v.optional(v.id("radarProducts")),
      isActive: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const offers = await ctx.db
      .query("radarWholesaleOffers")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .take(args.limit ?? 100);
    return offers.map((o) => ({
      _id: o._id,
      sku: o.sku,
      title: o.title,
      unitPrice: o.unitPrice,
      currency: o.currency,
      moq: o.moq,
      leadTimeDays: o.leadTimeDays,
      productId: o.productId,
      isActive: o.isActive,
    }));
  },
});

export const importSocialSignalsBatch = mutation({
  args: {
    signals: v.array(
      v.object({
        productId: v.id("radarProducts"),
        source: dataSourceValidator,
        mentionCount: v.optional(v.number()),
        viewCount: v.optional(v.number()),
        creatorCount: v.optional(v.number()),
        engagementCount: v.optional(v.number()),
        purchaseIntentCount: v.optional(v.number()),
        capturedAt: v.optional(v.number()),
        metadataJson: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    let inserted = 0;
    for (const signal of args.signals) {
      const capturedAt = signal.capturedAt ?? Date.now();
      const periodKey = periodKeyFromTs(capturedAt);
      const allowed = new Set([
        "manual_social",
        "tiktok",
        "instagram",
        "youtube",
        "reddit",
      ]);
      if (!allowed.has(signal.source)) {
        throw new Error(`Invalid social source: ${signal.source}`);
      }
      const existing = await ctx.db
        .query("radarSocialSignals")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", signal.productId)
            .eq("source", signal.source)
            .eq("periodKey", periodKey),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          mentionCount: signal.mentionCount,
          viewCount: signal.viewCount,
          creatorCount: signal.creatorCount,
          engagementCount: signal.engagementCount,
          purchaseIntentCount: signal.purchaseIntentCount,
          metadataJson: signal.metadataJson,
        });
      } else {
        await ctx.db.insert("radarSocialSignals", {
          productId: signal.productId,
          source: signal.source,
          capturedAt,
          periodKey,
          mentionCount: signal.mentionCount,
          viewCount: signal.viewCount,
          creatorCount: signal.creatorCount,
          engagementCount: signal.engagementCount,
          purchaseIntentCount: signal.purchaseIntentCount,
          metadataJson: signal.metadataJson,
        });
        inserted += 1;
      }

      const snapExists = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", signal.productId)
            .eq("source", signal.source)
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!snapExists) {
        await ctx.db.insert("radarProductSnapshots", {
          productId: signal.productId,
          source: signal.source,
          capturedAt,
          periodKey,
          mentionCount: signal.mentionCount,
          viewCount: signal.viewCount,
          metadataJson: signal.metadataJson,
        });
      }
    }
    return { inserted };
  },
});
