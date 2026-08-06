/**
 * Cache for the Mercado Libre OAuth token pair. Singleton row — Mercado
 * Libre refresh tokens rotate on every use, so the currently-valid pair
 * has to live in the DB, not just in the static env var used to bootstrap
 * it. See providers/mlAuth.ts for the resolve/refresh logic.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

const cachedTokenValidator = v.object({
  accessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  refreshToken: v.string(),
});

export const getCachedToken = internalQuery({
  args: {},
  returns: v.union(cachedTokenValidator, v.null()),
  handler: async (ctx) => {
    const [row] = await ctx.db.query("radarMercadoLibreToken").take(1);
    if (!row) return null;
    return {
      accessToken: row.accessToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      refreshToken: row.refreshToken,
    };
  },
});

export const saveToken = internalMutation({
  args: cachedTokenValidator.fields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const [existing] = await ctx.db.query("radarMercadoLibreToken").take(1);
    const doc = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("radarMercadoLibreToken", doc);
    }
    return null;
  },
});
