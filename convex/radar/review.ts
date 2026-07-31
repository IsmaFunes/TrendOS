import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireCurrentUser } from "../lib/auth";
import { reviewStatusValidator } from "./validators";
import { normalizeAlias } from "./normalize";

export const listReviewQueue = query({
  args: {
    status: v.optional(reviewStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("radarReviewQueue"),
      status: reviewStatusValidator,
      candidateProductId: v.optional(v.id("radarProducts")),
      existingProductId: v.optional(v.id("radarProducts")),
      listingId: v.optional(v.id("radarMarketplaceListings")),
      proposedAlias: v.optional(v.string()),
      matchConfidence: v.number(),
      matchMethod: v.string(),
      explanation: v.optional(v.string()),
      createdAt: v.number(),
      candidateName: v.optional(v.string()),
      existingName: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireCurrentUser(ctx);
    const status = args.status ?? "pending";
    const limit = args.limit ?? 50;
    const items = await ctx.db
      .query("radarReviewQueue")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .take(limit);

    const result = [];
    for (const item of items) {
      let candidateName: string | undefined;
      let existingName: string | undefined;
      if (item.candidateProductId) {
        candidateName = (await ctx.db.get(item.candidateProductId))
          ?.canonicalName;
      }
      if (item.existingProductId) {
        existingName = (await ctx.db.get(item.existingProductId))
          ?.canonicalName;
      }
      result.push({
        _id: item._id,
        status: item.status,
        candidateProductId: item.candidateProductId,
        existingProductId: item.existingProductId,
        listingId: item.listingId,
        proposedAlias: item.proposedAlias,
        matchConfidence: item.matchConfidence,
        matchMethod: item.matchMethod,
        explanation: item.explanation,
        createdAt: item.createdAt,
        candidateName,
        existingName,
      });
    }
    return result;
  },
});

export const resolveReview = mutation({
  args: {
    reviewId: v.id("radarReviewQueue"),
    resolution: v.union(
      v.literal("merged"),
      v.literal("kept_separate"),
      v.literal("dismissed"),
    ),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const item = await ctx.db.get(args.reviewId);
    if (!item) throw new Error("Review item not found");
    if (item.status !== "pending") {
      throw new Error("Review already resolved");
    }

    if (
      args.resolution === "merged" &&
      item.candidateProductId &&
      item.existingProductId
    ) {
      const listings = await ctx.db
        .query("radarMarketplaceListings")
        .withIndex("by_product", (q) =>
          q.eq("productId", item.candidateProductId!),
        )
        .collect();
      for (const listing of listings) {
        await ctx.db.patch(listing._id, {
          productId: item.existingProductId,
        });
      }
      if (item.proposedAlias) {
        const normalized = normalizeAlias(item.proposedAlias);
        const existingAlias = await ctx.db
          .query("radarProductAliases")
          .withIndex("by_product_and_normalized", (q) =>
            q
              .eq("productId", item.existingProductId!)
              .eq("normalizedAlias", normalized),
          )
          .unique();
        if (!existingAlias) {
          await ctx.db.insert("radarProductAliases", {
            productId: item.existingProductId,
            alias: item.proposedAlias,
            normalizedAlias: normalized,
            source: "simulated",
            createdAt: Date.now(),
          });
        }
      }
      await ctx.db.patch(item.candidateProductId, {
        status: "archived",
        updatedAt: Date.now(),
      });
    }

    if (args.resolution === "kept_separate" && item.candidateProductId) {
      await ctx.db.patch(item.candidateProductId, {
        status: "tracked",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(args.reviewId, {
      status: args.resolution,
      resolvedAt: Date.now(),
      resolvedBy: user._id,
      resolutionNote: args.note,
    });
    return null;
  },
});
