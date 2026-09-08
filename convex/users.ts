import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUserOrNull, requireIdentity } from "./lib/auth";
import {
  clampNicheDescription,
  clampShortNotes,
  MAX_LOGISTICS_CONSTRAINTS_LENGTH,
  MAX_STORAGE_NOTES_LENGTH,
} from "./lib/nicheProfile";
import { businessGoalValidator } from "./radar/validators";

/** Free plan picks one niche; pro can follow up to 3. */
function maxNichesForPlan(plan: "free" | "pro"): number {
  return plan === "pro" ? 3 : 1;
}

async function validateNicheIds(
  ctx: MutationCtx,
  nicheIds: Id<"radarNiches">[],
  plan: "free" | "pro",
): Promise<Id<"radarNiches">[]> {
  if (nicheIds.length === 0) {
    throw new Error("Elegí al menos un nicho");
  }
  const max = maxNichesForPlan(plan);
  if (nicheIds.length > max) {
    throw new Error(
      plan === "pro"
        ? `El plan Pro permite hasta ${max} nichos`
        : "El plan Free permite elegir un solo nicho",
    );
  }
  const unique = new Set(nicheIds.map((id) => String(id)));
  if (unique.size !== nicheIds.length) {
    throw new Error("Nicho repetido");
  }
  for (const nicheId of nicheIds) {
    const niche = await ctx.db.get(nicheId);
    if (!niche || !niche.isActive) {
      throw new Error("Nicho inválido");
    }
  }
  return nicheIds;
}

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
  channels: v.optional(v.array(v.string())),
  goal: v.optional(businessGoalValidator),
  existingStoreUrl: v.optional(v.string()),
  monthlyRevenueRange: v.optional(v.string()),
  targetMarginPercent: v.optional(v.number()),
  notes: v.optional(v.string()),
  hasWarehouseStorage: v.optional(v.boolean()),
  storageNotes: v.optional(v.string()),
  logisticsConstraints: v.optional(v.string()),
  nicheIds: v.array(v.id("radarNiches")),
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
    description: v.optional(v.string()),
    nicheIds: v.array(v.id("radarNiches")),
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

    const nicheIds = await validateNicheIds(ctx, args.nicheIds, user.plan);
    const description = clampNicheDescription(args.description);
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

    const existingProfile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    const profileData = {
      userId: user._id,
      businessName,
      description,
      channels: args.channels,
      goal: args.goal,
      existingStoreUrl: storeUrl || undefined,
      hasWarehouseStorage: args.hasWarehouseStorage,
      storageNotes:
        args.hasWarehouseStorage === true ? storageNotes : undefined,
      logisticsConstraints,
      nicheIds,
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
    channels: v.optional(v.array(v.string())),
    monthlyRevenueRange: v.optional(v.string()),
    targetMarginPercent: v.optional(v.number()),
    nicheIds: v.optional(v.array(v.id("radarNiches"))),
    categoryIds: v.optional(v.array(v.id("categories"))),
    siteId: v.optional(v.string()),
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

    const description = clampNicheDescription(args.description);
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

    // categoryIds is a separate self-tagging feature (used standalone on
    // /tienda) unrelated to niche selection — omitted means leave existing
    // links untouched.
    if (args.categoryIds) {
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

    // nicheIds omitted means leave the existing niche selection untouched.
    const nicheIds = args.nicheIds
      ? await validateNicheIds(ctx, args.nicheIds, user.plan)
      : (existingProfile?.nicheIds ?? []);
    if (nicheIds.length === 0) {
      throw new Error("Elegí al menos un nicho");
    }

    const profileData = {
      userId: user._id,
      businessName: args.businessName.trim(),
      description,
      channels: args.channels,
      monthlyRevenueRange: args.monthlyRevenueRange,
      targetMarginPercent: args.targetMarginPercent,
      hasWarehouseStorage: args.hasWarehouseStorage,
      storageNotes:
        args.hasWarehouseStorage === true ? storageNotes : undefined,
      logisticsConstraints,
      nicheIds,
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
