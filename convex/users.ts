import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUserOrNull, requireIdentity } from "./lib/auth";
import {
  clampNicheDescription,
  clampShortNotes,
  hasNicheSignal,
  MAX_LOGISTICS_CONSTRAINTS_LENGTH,
  MAX_STORAGE_NOTES_LENGTH,
  normalizeExcludedKeywords,
  normalizeNicheKeywords,
} from "./lib/nicheProfile";
import { businessGoalValidator } from "./radar/validators";
import { resolveOrCreateNicheCore } from "./radar/niches";

async function upsertUserFromIdentity(ctx: MutationCtx): Promise<Id<"users">> {
  const identity = await requireIdentity(ctx);
  const existing = await getCurrentUserOrNull(ctx);
  if (existing) {
    await ctx.db.patch(existing._id, {
      name: identity.name ?? existing.name,
      email: identity.email ?? existing.email,
      tokenIdentifier: identity.tokenIdentifier,
      clerkId: identity.subject,
    });
    return existing._id;
  }

  return await ctx.db.insert("users", {
    tokenIdentifier: identity.tokenIdentifier,
    clerkId: identity.subject,
    name: identity.name,
    email: identity.email,
    siteId: "MLA",
    plan: "free",
    refreshIntervalHours: 8,
    onboardingComplete: false,
    createdAt: Date.now(),
  });
}

const businessProfileReturn = v.object({
  _id: v.id("businessProfiles"),
  _creationTime: v.number(),
  userId: v.id("users"),
  businessName: v.string(),
  description: v.optional(v.string()),
  nicheKeywords: v.optional(v.array(v.string())),
  excludedKeywords: v.optional(v.array(v.string())),
  channels: v.optional(v.array(v.string())),
  goal: v.optional(businessGoalValidator),
  existingStoreUrl: v.optional(v.string()),
  monthlyRevenueRange: v.optional(v.string()),
  targetMarginPercent: v.optional(v.number()),
  notes: v.optional(v.string()),
  hasWarehouseStorage: v.optional(v.boolean()),
  storageNotes: v.optional(v.string()),
  logisticsConstraints: v.optional(v.string()),
  nicheId: v.optional(v.id("radarNiches")),
  updatedAt: v.number(),
});

export const me = query({
  args: {},
  returns: v.union(
    v.object({
      _id: v.id("users"),
      _creationTime: v.number(),
      tokenIdentifier: v.string(),
      clerkId: v.string(),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      siteId: v.string(),
      plan: v.union(v.literal("free"), v.literal("pro")),
      refreshIntervalHours: v.number(),
      onboardingComplete: v.boolean(),
      createdAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    return await getCurrentUserOrNull(ctx);
  },
});

export const ensureUser = mutation({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => {
    return await upsertUserFromIdentity(ctx);
  },
});

export const completeOnboarding = mutation({
  args: {
    goal: businessGoalValidator,
    channels: v.optional(v.array(v.string())),
    existingStoreUrl: v.optional(v.string()),
    nicheKeywords: v.optional(v.array(v.string())),
    excludedKeywords: v.optional(v.array(v.string())),
    description: v.optional(v.string()),
    categoryIds: v.optional(v.array(v.id("categories"))),
    businessName: v.optional(v.string()),
    hasWarehouseStorage: v.optional(v.boolean()),
    storageNotes: v.optional(v.string()),
    logisticsConstraints: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await upsertUserFromIdentity(ctx);
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found after signup");
    }

    const nicheKeywords = normalizeNicheKeywords(args.nicheKeywords);
    const description = clampNicheDescription(args.description);
    if (
      args.goal !== "browse_ads" &&
      !hasNicheSignal({ keywords: nicheKeywords, description })
    ) {
      throw new Error(
        "Contanos qué tipo de productos te interesan (al menos una palabra clave)",
      );
    }

    const excludedKeywords = normalizeExcludedKeywords(args.excludedKeywords);
    const storageNotes = clampShortNotes(
      args.storageNotes,
      MAX_STORAGE_NOTES_LENGTH,
    );
    const logisticsConstraints = clampShortNotes(
      args.logisticsConstraints,
      MAX_LOGISTICS_CONSTRAINTS_LENGTH,
    );

    const storeUrl = args.existingStoreUrl?.trim();
    const businessName =
      args.businessName?.trim() ||
      user.name?.trim() ||
      "Mi negocio";

    await ctx.db.patch(user._id, {
      siteId: "MLA",
      onboardingComplete: true,
    });

    const categoryIds = args.categoryIds ?? [];
    const existingLinks = await ctx.db
      .query("userCategories")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const link of existingLinks) {
      await ctx.db.delete(link._id);
    }
    for (const categoryId of categoryIds) {
      await ctx.db.insert("userCategories", {
        userId: user._id,
        categoryId,
      });
    }

    const existingProfile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    let nicheId = existingProfile?.nicheId;
    if (nicheKeywords.length > 0 || description) {
      const resolved = await resolveOrCreateNicheCore(ctx, {
        keywords: nicheKeywords,
        description,
        country: "AR",
      });
      nicheId = resolved.nicheId;
    }

    const profileData = {
      userId: user._id,
      businessName,
      description,
      nicheKeywords: nicheKeywords.length ? nicheKeywords : undefined,
      excludedKeywords: excludedKeywords.length
        ? excludedKeywords
        : undefined,
      channels: args.channels,
      goal: args.goal,
      existingStoreUrl: storeUrl || undefined,
      hasWarehouseStorage: args.hasWarehouseStorage,
      storageNotes:
        args.hasWarehouseStorage === true ? storageNotes : undefined,
      logisticsConstraints,
      nicheId,
      updatedAt: Date.now(),
    };

    if (existingProfile) {
      await ctx.db.patch(existingProfile._id, profileData);
    } else {
      await ctx.db.insert("businessProfiles", profileData);
    }

    return null;
  },
});

export const updateBusinessProfile = mutation({
  args: {
    businessName: v.string(),
    description: v.optional(v.string()),
    nicheKeywords: v.optional(v.array(v.string())),
    excludedKeywords: v.optional(v.array(v.string())),
    channels: v.optional(v.array(v.string())),
    monthlyRevenueRange: v.optional(v.string()),
    targetMarginPercent: v.optional(v.number()),
    categoryIds: v.optional(v.array(v.id("categories"))),
    siteId: v.optional(v.string()),
    scheduleResearch: v.optional(v.boolean()),
    hasWarehouseStorage: v.optional(v.boolean()),
    storageNotes: v.optional(v.string()),
    logisticsConstraints: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");
    if (!user.onboardingComplete) {
      throw new Error("Completá el onboarding primero");
    }

    if (!args.businessName.trim()) {
      throw new Error("Business name is required");
    }

    const nicheKeywords = normalizeNicheKeywords(args.nicheKeywords);
    const description = clampNicheDescription(args.description);
    if (!hasNicheSignal({ keywords: nicheKeywords, description })) {
      throw new Error(
        "Agregá al menos 1 keyword o una descripción corta de lo que revendés",
      );
    }

    const excludedKeywords = normalizeExcludedKeywords(args.excludedKeywords);
    const storageNotes = clampShortNotes(
      args.storageNotes,
      MAX_STORAGE_NOTES_LENGTH,
    );
    const logisticsConstraints = clampShortNotes(
      args.logisticsConstraints,
      MAX_LOGISTICS_CONSTRAINTS_LENGTH,
    );

    if (args.siteId) {
      await ctx.db.patch(user._id, { siteId: args.siteId });
    }

    if (args.categoryIds) {
      if (args.categoryIds.length === 0) {
        throw new Error("Select at least one category");
      }
      const existingLinks = await ctx.db
        .query("userCategories")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();
      for (const link of existingLinks) {
        await ctx.db.delete(link._id);
      }
      for (const categoryId of args.categoryIds) {
        await ctx.db.insert("userCategories", {
          userId: user._id,
          categoryId,
        });
      }
    }

    const existingProfile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    let nicheId = existingProfile?.nicheId;
    if (nicheKeywords.length > 0 || description) {
      const resolved = await resolveOrCreateNicheCore(ctx, {
        keywords: nicheKeywords,
        description,
        country: "AR",
      });
      nicheId = resolved.nicheId;
    }

    const profileData = {
      userId: user._id,
      businessName: args.businessName.trim(),
      description,
      nicheKeywords: nicheKeywords.length ? nicheKeywords : undefined,
      excludedKeywords: excludedKeywords.length
        ? excludedKeywords
        : undefined,
      channels: args.channels,
      monthlyRevenueRange: args.monthlyRevenueRange,
      targetMarginPercent: args.targetMarginPercent,
      hasWarehouseStorage: args.hasWarehouseStorage,
      storageNotes:
        args.hasWarehouseStorage === true ? storageNotes : undefined,
      logisticsConstraints,
      nicheId,
      updatedAt: Date.now(),
    };

    if (existingProfile) {
      await ctx.db.patch(existingProfile._id, profileData);
    } else {
      await ctx.db.insert("businessProfiles", profileData);
    }

    void args.scheduleResearch;

    return null;
  },
});

export const getBusinessProfile = query({
  args: {},
  returns: v.union(businessProfileReturn, v.null()),
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    return await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
  },
});
