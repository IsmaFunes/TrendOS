/**
 * Dev-only clean slate for the Meta Ad Library pipeline — wipes every
 * ad/niche/match table and clears each businessProfile's nicheId, WITHOUT
 * touching users/categories/businessProfiles otherwise. Unlike admin/wipeAll,
 * this keeps accounts and onboarding answers intact: the next /ads visit
 * re-resolves a fresh niche bucket from the user's existing saved keywords
 * and queues a brand-new scrape, with no re-onboarding needed.
 *
 *   npx convex run admin/resetAdsPipeline:resetAdsPipeline '{"confirm":"RESET_ADS"}'
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

const BATCH = 256;

type AdsPipelineTable =
  | "radarNicheAdRelevance"
  | "radarAdInvestigations"
  | "radarNicheAds"
  | "radarNicheScrapeJobs"
  | "radarNiches"
  | "radarAds"
  | "radarAdvertisers"
  | "radarStores";

const ADS_PIPELINE_TABLES: AdsPipelineTable[] = [
  // Delete dependents before the tables they reference.
  "radarNicheAdRelevance",
  "radarAdInvestigations",
  "radarNicheAds",
  "radarNicheScrapeJobs",
  "radarNiches",
  "radarAds",
  "radarAdvertisers",
  "radarStores",
];

export const wipeAdsPipelineTableBatch = internalMutation({
  args: { table: v.string() },
  returns: v.object({ deleted: v.number(), remainingHint: v.boolean() }),
  handler: async (ctx, args) => {
    const table = args.table as AdsPipelineTable;
    if (!ADS_PIPELINE_TABLES.includes(table)) {
      throw new Error(`Not an ads-pipeline table: ${args.table}`);
    }
    const page = await ctx.db.query(table).take(BATCH);
    for (const doc of page) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: page.length, remainingHint: page.length === BATCH };
  },
});

export const clearBusinessProfileNicheIdsBatch = internalMutation({
  args: {},
  returns: v.object({ cleared: v.number(), remainingHint: v.boolean() }),
  handler: async (ctx) => {
    // businessProfiles is one row per user (no index needed for a full,
    // bounded sweep) — unconditional patch is cheap and idempotent even
    // for rows that already have no nicheId.
    const page = await ctx.db.query("businessProfiles").take(BATCH);
    for (const profile of page) {
      if (profile.nicheId !== undefined) {
        await ctx.db.patch(profile._id, { nicheId: undefined });
      }
    }
    return { cleared: page.length, remainingHint: page.length === BATCH };
  },
});

export const resetAdsPipeline = internalAction({
  args: { confirm: v.string() },
  returns: v.object({
    tables: v.array(v.object({ table: v.string(), deleted: v.number() })),
    profilesCleared: v.number(),
    totalDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.confirm !== "RESET_ADS") {
      throw new Error('Pass confirm: "RESET_ADS" to proceed');
    }

    const tables: Array<{ table: string; deleted: number }> = [];
    let totalDeleted = 0;
    for (const table of ADS_PIPELINE_TABLES) {
      let deleted = 0;
      for (;;) {
        const batch: { deleted: number; remainingHint: boolean } =
          await ctx.runMutation(
            internal.admin.resetAdsPipeline.wipeAdsPipelineTableBatch,
            { table },
          );
        deleted += batch.deleted;
        if (!batch.remainingHint) break;
      }
      tables.push({ table, deleted });
      totalDeleted += deleted;
    }

    let profilesCleared = 0;
    for (;;) {
      const batch: { cleared: number; remainingHint: boolean } =
        await ctx.runMutation(
          internal.admin.resetAdsPipeline.clearBusinessProfileNicheIdsBatch,
          {},
        );
      profilesCleared += batch.cleared;
      if (!batch.remainingHint) break;
    }

    return { tables, profilesCleared, totalDeleted };
  },
});
