/**
 * Fixed niche catalog — a curated, admin-seeded set of niches users pick
 * from at onboarding (convex/admin/seedNicheCatalog.ts). Ads are scraped
 * continuously in the background (daily cron, across every country in a
 * niche's scrapeTermsByCountry) so a niche already has ads before any user
 * ever selects it — there is no per-user resolution or on-demand scrape
 * trigger anymore.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Below this, a niche's status stays "pending_scrape" — this counts
 * gate-passed ads BEFORE the Gemini relevance pass drops some fraction of
 * them, so it needs headroom above the number we actually want to show.
 */
export const MIN_ADS_READY = 10;

const nicheStatusValidator = v.union(
  v.literal("ready"),
  v.literal("pending_scrape"),
  v.literal("scraping"),
);

const scrapeTermsByCountryValidator = v.array(
  v.object({ country: v.string(), terms: v.array(v.string()) }),
);

const nicheReturnValidator = v.object({
  _id: v.id("radarNiches"),
  _creationTime: v.number(),
  slug: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  scrapeTermsByCountry: scrapeTermsByCountryValidator,
  adCount: v.number(),
  lastScrapedAt: v.optional(v.number()),
  status: nicheStatusValidator,
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/** All curated terms across every country, deduped — used by the ad gate. */
export function flattenedGateTerms(niche: Doc<"radarNiches">): string[] {
  const set = new Set<string>();
  for (const entry of niche.scrapeTermsByCountry) {
    for (const t of entry.terms) set.add(t);
  }
  return [...set];
}

/** Public: niches the onboarding/tienda picker can offer. */
export const listActive = query({
  args: {},
  returns: v.array(nicheReturnValidator),
  handler: async (ctx) => {
    return await ctx.db
      .query("radarNiches")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
  },
});

export const getNiche = query({
  args: { nicheId: v.id("radarNiches") },
  returns: v.union(nicheReturnValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.nicheId);
  },
});

export const getNicheInternal = internalQuery({
  args: { nicheId: v.id("radarNiches") },
  returns: v.union(nicheReturnValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.nicheId);
  },
});

/**
 * Daily cron: one scrape job per (active niche, country) pair that doesn't
 * already have one pending/claimed. Terms are curated ahead of time — no
 * per-scrape Gemini enrichment step, so jobs start "pending" immediately.
 */
export const enqueueDailyScrapeJobs = internalMutation({
  args: {},
  returns: v.object({ enqueued: v.number() }),
  handler: async (ctx) => {
    const niches = await ctx.db
      .query("radarNiches")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();

    let enqueued = 0;
    for (const niche of niches) {
      for (const { country, terms } of niche.scrapeTermsByCountry) {
        if (terms.length === 0) continue;
        let inFlight = false;
        for (const status of ["pending", "claimed"] as const) {
          const existing = await ctx.db
            .query("radarNicheScrapeJobs")
            .withIndex("by_niche_country_status", (q) =>
              q
                .eq("nicheId", niche._id)
                .eq("country", country)
                .eq("status", status),
            )
            .first();
          if (existing) {
            inFlight = true;
            break;
          }
        }
        if (inFlight) continue;

        await ctx.db.insert("radarNicheScrapeJobs", {
          nicheId: niche._id,
          country,
          terms,
          status: "pending",
          createdAt: Date.now(),
        });
        enqueued += 1;
      }
    }

    if (enqueued > 0) {
      // Best-effort: kick the GitHub Actions worker now instead of waiting
      // for its poll — see githubDispatch.ts. No-ops silently without
      // GITHUB_ACTIONS_TOKEN configured; the scheduled poll still covers it.
      await ctx.scheduler.runAfter(
        0,
        internal.radar.githubDispatch.dispatchScrapeWorkflow,
        {},
      );
    }

    return { enqueued };
  },
});

/**
 * Admin/worker: force-queue job(s) even if a niche already has ads —
 * pass nicheId to scope to one niche (all its countries, or one country),
 * or omit to force every active niche.
 */
export const forceEnqueueScrapeJobs = mutation({
  args: {
    secret: v.string(),
    nicheId: v.optional(v.id("radarNiches")),
    country: v.optional(v.string()),
  },
  returns: v.object({
    enqueued: v.number(),
    nicheIds: v.array(v.id("radarNiches")),
  }),
  handler: async (ctx, args) => {
    const expected = process.env.META_ADS_INGEST_SECRET?.trim();
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }

    const niches: Doc<"radarNiches">[] = [];
    if (args.nicheId) {
      const one = await ctx.db.get(args.nicheId);
      if (!one) throw new Error("Niche not found");
      niches.push(one);
    } else {
      niches.push(
        ...(await ctx.db
          .query("radarNiches")
          .withIndex("by_active", (q) => q.eq("isActive", true))
          .collect()),
      );
    }

    const now = Date.now();
    const nicheIds: Id<"radarNiches">[] = [];
    let enqueued = 0;

    for (const niche of niches) {
      const countryEntries = args.country
        ? niche.scrapeTermsByCountry.filter((c) => c.country === args.country)
        : niche.scrapeTermsByCountry;

      for (const { country, terms } of countryEntries) {
        if (terms.length === 0) continue;

        // Unstick a claimed (mid-scrape) job so force can proceed.
        const stuck = await ctx.db
          .query("radarNicheScrapeJobs")
          .withIndex("by_niche_country_status", (q) =>
            q
              .eq("nicheId", niche._id)
              .eq("country", country)
              .eq("status", "claimed"),
          )
          .collect();
        for (const job of stuck) {
          await ctx.db.patch(job._id, {
            status: "failed",
            finishedAt: now,
            error: "superseded_by_force",
          });
        }

        const pending = await ctx.db
          .query("radarNicheScrapeJobs")
          .withIndex("by_niche_country_status", (q) =>
            q
              .eq("nicheId", niche._id)
              .eq("country", country)
              .eq("status", "pending"),
          )
          .first();
        if (pending) continue;

        await ctx.db.insert("radarNicheScrapeJobs", {
          nicheId: niche._id,
          country,
          terms,
          status: "pending",
          createdAt: now,
        });
        enqueued += 1;
      }
      nicheIds.push(niche._id);
    }

    if (enqueued > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.radar.githubDispatch.dispatchScrapeWorkflow,
        {},
      );
    }

    return { enqueued, nicheIds };
  },
});

/**
 * Worker: claim next pending scrape job. Pass `nicheId`/`country` to claim
 * a specific (niche, country) job rather than the oldest pending job
 * overall — used by `--force-niche` so it scrapes the intended target
 * instead of whatever else happens to be queued.
 */
export const claimNextScrapeJob = mutation({
  args: {
    secret: v.string(),
    nicheId: v.optional(v.id("radarNiches")),
    country: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      jobId: v.id("radarNicheScrapeJobs"),
      nicheId: v.id("radarNiches"),
      terms: v.array(v.string()),
      country: v.string(),
      label: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const expected = process.env.META_ADS_INGEST_SECRET?.trim();
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }

    let job: Doc<"radarNicheScrapeJobs"> | null = null;
    if (args.nicheId && args.country) {
      job = await ctx.db
        .query("radarNicheScrapeJobs")
        .withIndex("by_niche_country_status", (q) =>
          q
            .eq("nicheId", args.nicheId!)
            .eq("country", args.country!)
            .eq("status", "pending"),
        )
        .first();
    } else if (args.nicheId) {
      job = await ctx.db
        .query("radarNicheScrapeJobs")
        .withIndex("by_niche_status", (q) =>
          q.eq("nicheId", args.nicheId!).eq("status", "pending"),
        )
        .first();
    } else {
      job = await ctx.db
        .query("radarNicheScrapeJobs")
        .withIndex("by_status_created", (q) => q.eq("status", "pending"))
        .order("asc")
        .first();
    }
    if (!job) return null;

    const niche = await ctx.db.get(job.nicheId);
    if (!niche) {
      await ctx.db.patch(job._id, {
        status: "failed",
        finishedAt: Date.now(),
        error: "niche_missing",
      });
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(job._id, { status: "claimed", claimedAt: now });
    await ctx.db.patch(niche._id, {
      status: "scraping",
      updatedAt: now,
    });

    return {
      jobId: job._id,
      nicheId: niche._id,
      terms: job.terms,
      country: job.country,
      label: niche.label,
    };
  },
});

export const completeScrapeJob = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("radarNicheScrapeJobs"),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const expected = process.env.META_ADS_INGEST_SECRET?.trim();
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;

    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: args.ok ? "completed" : "failed",
      finishedAt: now,
      error: args.error,
    });

    const niche = await ctx.db.get(job.nicheId);
    if (niche) {
      const linkCount = (
        await ctx.db
          .query("radarNicheAds")
          .withIndex("by_niche", (q) => q.eq("nicheId", niche._id))
          .take(2000)
      ).length;
      await ctx.db.patch(niche._id, {
        adCount: linkCount,
        lastScrapedAt: now,
        status: linkCount >= MIN_ADS_READY ? "ready" : "pending_scrape",
        updatedAt: now,
      });
    }
    return null;
  },
});
