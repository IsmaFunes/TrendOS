/**
 * Dev-only clean slate for the Meta Ad Library pipeline — wipes every
 * scraped ad/match table and resets every niche back to "pending_scrape"
 * with 0 ads, WITHOUT touching the niche catalog rows themselves or any
 * user's chosen nicheIds (a niche is now a fixed, admin-seeded catalog
 * entry, not per-user data — wiping its ad pool doesn't invalidate anyone's
 * selection, it just means the next scrape cycle repopulates it).
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
  | "radarAds"
  | "radarAdvertisers"
  | "radarStores";

const ADS_PIPELINE_TABLES: AdsPipelineTable[] = [
  // Delete dependents before the tables they reference.
  "radarNicheAdRelevance",
  "radarAdInvestigations",
  "radarNicheAds",
  "radarNicheScrapeJobs",
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

export const resetNicheStatsBatch = internalMutation({
  args: {},
  returns: v.object({ reset: v.number(), remainingHint: v.boolean() }),
  handler: async (ctx) => {
    const page = await ctx.db.query("radarNiches").take(BATCH);
    for (const niche of page) {
      await ctx.db.patch(niche._id, {
        adCount: 0,
        lastScrapedAt: undefined,
        status: "pending_scrape",
        updatedAt: Date.now(),
      });
    }
    return { reset: page.length, remainingHint: page.length === BATCH };
  },
});

export const resetAdsPipeline = internalAction({
  args: { confirm: v.string() },
  returns: v.object({
    tables: v.array(v.object({ table: v.string(), deleted: v.number() })),
    nichesReset: v.number(),
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

    let nichesReset = 0;
    for (;;) {
      const batch: { reset: number; remainingHint: boolean } =
        await ctx.runMutation(
          internal.admin.resetAdsPipeline.resetNicheStatsBatch,
          {},
        );
      nichesReset += batch.reset;
      if (!batch.remainingHint) break;
    }

    return { tables, nichesReset, totalDeleted };
  },
});
