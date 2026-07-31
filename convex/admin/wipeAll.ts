/**
 * Dev clean slate — wipe all app data (and legacy trend* tables if present).
 *
 *   npx convex run admin/wipeAll:wipeAll '{"confirm":"WIPE_ALL_DATA"}'
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const BATCH = 256;

type SchemaTable =
  | "radarAdRankings"
  | "radarNicheAds"
  | "radarNicheScrapeJobs"
  | "radarNiches"
  | "radarAds"
  | "radarStores"
  | "radarAdvertisers"
  | "radarProductBusinessData"
  | "radarProductFeatures"
  | "radarProductScores"
  | "radarProductSnapshots"
  | "radarSocialSignals"
  | "radarProductAliases"
  | "radarMarketplaceListings"
  | "radarReviewQueue"
  | "radarWholesaleOffers"
  | "radarSearchTermSnapshots"
  | "radarSearchTerms"
  | "radarJobs"
  | "radarSeasonalEvents"
  | "radarScoringConfig"
  | "radarProducts"
  | "userCategories"
  | "businessProfiles"
  | "categories"
  | "users";

const SCHEMA_TABLES: SchemaTable[] = [
  "radarAdRankings",
  "radarNicheAds",
  "radarNicheScrapeJobs",
  "radarNiches",
  "radarAds",
  "radarStores",
  "radarAdvertisers",
  "radarProductBusinessData",
  "radarProductFeatures",
  "radarProductScores",
  "radarProductSnapshots",
  "radarSocialSignals",
  "radarProductAliases",
  "radarMarketplaceListings",
  "radarReviewQueue",
  "radarWholesaleOffers",
  "radarSearchTermSnapshots",
  "radarSearchTerms",
  "radarJobs",
  "radarSeasonalEvents",
  "radarScoringConfig",
  "radarProducts",
  "userCategories",
  "businessProfiles",
  "categories",
  "users",
];

export const wipeSchemaTableBatch = internalMutation({
  args: {
    table: v.string(),
  },
  returns: v.object({
    deleted: v.number(),
    remainingHint: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const table = args.table as SchemaTable;
    if (!SCHEMA_TABLES.includes(table)) {
      throw new Error(`Unknown schema table: ${args.table}`);
    }

    const page = await ctx.db.query(table).take(BATCH);
    for (const doc of page) {
      await ctx.db.delete(doc._id);
    }
    return {
      deleted: page.length,
      remainingHint: page.length === BATCH,
    };
  },
});

/**
 * Best-effort wipe of legacy tables removed from schema.
 * Uses raw table names; no-ops if the table is already gone.
 */
export const wipeLegacyTableBatch = internalMutation({
  args: {
    table: v.string(),
  },
  returns: v.object({
    deleted: v.number(),
    remainingHint: v.boolean(),
    missing: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const allowed = new Set([
      "trendKeywords",
      "trendProducts",
      "trendRuns",
      "trendSnapshots",
    ]);
    if (!allowed.has(args.table)) {
      throw new Error(`Not a legacy wipe table: ${args.table}`);
    }

    try {
      // Legacy tables may exist only on the deployment, not in generated types.
      const page = await (
        ctx.db as unknown as {
          query: (t: string) => {
            take: (n: number) => Promise<Array<{ _id: Id<"users"> }>>;
          };
        }
      )
        .query(args.table)
        .take(BATCH);

      for (const doc of page) {
        await ctx.db.delete(doc._id);
      }
      return {
        deleted: page.length,
        remainingHint: page.length === BATCH,
        missing: false,
      };
    } catch {
      return { deleted: 0, remainingHint: false, missing: true };
    }
  },
});

export const wipeAll = internalAction({
  args: {
    confirm: v.string(),
  },
  returns: v.object({
    tables: v.array(
      v.object({
        table: v.string(),
        deleted: v.number(),
        missing: v.optional(v.boolean()),
      }),
    ),
    totalDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.confirm !== "WIPE_ALL_DATA") {
      throw new Error('Pass confirm: "WIPE_ALL_DATA" to proceed');
    }

    const tables: Array<{
      table: string;
      deleted: number;
      missing?: boolean;
    }> = [];
    let totalDeleted = 0;

    for (const table of SCHEMA_TABLES) {
      let deleted = 0;
      for (;;) {
        const batch = await ctx.runMutation(
          internal.admin.wipeAll.wipeSchemaTableBatch,
          { table },
        );
        deleted += batch.deleted;
        if (!batch.remainingHint) break;
      }
      tables.push({ table, deleted });
      totalDeleted += deleted;
    }

    for (const table of [
      "trendKeywords",
      "trendProducts",
      "trendRuns",
      "trendSnapshots",
    ]) {
      let deleted = 0;
      let missing = false;
      for (;;) {
        const batch = await ctx.runMutation(
          internal.admin.wipeAll.wipeLegacyTableBatch,
          { table },
        );
        deleted += batch.deleted;
        missing = batch.missing;
        if (!batch.remainingHint || batch.missing) break;
      }
      tables.push({ table, deleted, missing });
      totalDeleted += deleted;
    }

    return { tables, totalDeleted };
  },
});
