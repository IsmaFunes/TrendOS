import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

const categoryValidator = v.object({
  _id: v.id("categories"),
  _creationTime: v.number(),
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
});

const SEED_CATEGORIES = [
  {
    slug: "construccion",
    name: "Construcción",
    description: "Materiales y obras",
    mlCategoryIds: { MLA: "MLA15032" },
  },
  {
    slug: "herramientas",
    name: "Herramientas",
    description: "Herramientas manuales y eléctricas",
    mlCategoryIds: { MLA: "MLA407134" },
  },
  {
    slug: "home-deco",
    name: "Home & Deco",
    description: "Hogar y decoración",
    mlCategoryIds: { MLA: "MLA1574" },
  },
  {
    slug: "tecnologia",
    name: "Tecnología",
    description: "Electrónica y computación",
    mlCategoryIds: { MLA: "MLA1000" },
  },
  {
    slug: "belleza",
    name: "Belleza y Cuidado Personal",
    description: "Cosmética y cuidado",
    mlCategoryIds: { MLA: "MLA1246" },
  },
  {
    slug: "deportes",
    name: "Deportes y Fitness",
    description: "Equipamiento deportivo",
    mlCategoryIds: { MLA: "MLA1276" },
  },
  {
    slug: "moda",
    name: "Moda",
    description: "Indumentaria y accesorios",
    mlCategoryIds: { MLA: "MLA1430" },
  },
  {
    slug: "jardin",
    name: "Jardín y Exterior",
    description: "Jardinería y aire libre",
    mlCategoryIds: { MLA: "MLA1500" },
  },
] as const;

export const list = query({
  args: {},
  returns: v.array(categoryValidator),
  handler: async (ctx) => {
    return await ctx.db.query("categories").collect();
  },
});

export const listForUser = query({
  args: {},
  returns: v.array(categoryValidator),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) return [];

    const links = await ctx.db
      .query("userCategories")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const categories = [];
    for (const link of links) {
      const cat = await ctx.db.get(link.categoryId);
      if (cat) categories.push(cat);
    }
    return categories;
  },
});

export const seed = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let inserted = 0;
    for (const cat of SEED_CATEGORIES) {
      const existing = await ctx.db
        .query("categories")
        .withIndex("by_slug", (q) => q.eq("slug", cat.slug))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: cat.name,
          description: cat.description,
          mlCategoryIds: { ...cat.mlCategoryIds },
        });
      } else {
        await ctx.db.insert("categories", {
          slug: cat.slug,
          name: cat.name,
          description: cat.description,
          mlCategoryIds: { ...cat.mlCategoryIds },
        });
        inserted += 1;
      }
    }
    return inserted;
  },
});

export const seedInternal = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let inserted = 0;
    for (const cat of SEED_CATEGORIES) {
      const existing = await ctx.db
        .query("categories")
        .withIndex("by_slug", (q) => q.eq("slug", cat.slug))
        .unique();
      if (!existing) {
        await ctx.db.insert("categories", {
          slug: cat.slug,
          name: cat.name,
          description: cat.description,
          mlCategoryIds: { ...cat.mlCategoryIds },
        });
        inserted += 1;
      }
    }
    return inserted;
  },
});
