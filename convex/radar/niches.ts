/**
 * Niche buckets for Meta ad reuse across similar stores (AR).
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getCurrentUserOrNull } from "../lib/auth";
import {
  computeNicheKey,
  NICHE_REUSE_SIMILARITY_MIN,
  normalizeNicheKeywords,
  nicheSimilarity,
  type NicheInput,
} from "../lib/nicheProfile";

const AR = "AR";
/**
 * Below this, enqueue / keep scrape pending — a niche is not "ready" either.
 * Raised from 5: the feed shows a fixed top FEED_SIZE=10 (metaAds.ts), and
 * this counts gate-passed ads BEFORE the Gemini relevance pass drops some
 * fraction of them — 10 raw gives a realistic shot at 10 kept, 5 rarely did.
 */
export const MIN_ADS_READY = 10;

const nicheStatusValidator = v.union(
  v.literal("ready"),
  v.literal("pending_scrape"),
  v.literal("scraping"),
);

const nicheReturnValidator = v.object({
  _id: v.id("radarNiches"),
  _creationTime: v.number(),
  country: v.string(),
  nicheKey: v.string(),
  keywords: v.array(v.string()),
  scrapeTerms: v.optional(v.array(v.string())),
  label: v.string(),
  adCount: v.number(),
  lastScrapedAt: v.optional(v.number()),
  status: nicheStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});

function scrapeTermsForKeywords(keywords: string[]): string[] {
  const terms = [
    ...keywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
  ];
  return [...new Set(terms)].slice(0, 6);
}

function jobTermsFromNiche(niche: Doc<"radarNiches">): string[] {
  if (niche.scrapeTerms && niche.scrapeTerms.length > 0) {
    return [
      ...new Set(
        niche.scrapeTerms.map((t) => t.trim().toLowerCase()).filter(Boolean),
      ),
    ].slice(0, 8);
  }
  return scrapeTermsForKeywords(niche.keywords);
}

async function createScrapeJob(
  ctx: MutationCtx,
  nicheId: Id<"radarNiches">,
  terms: string[],
  description?: string,
): Promise<Id<"radarNicheScrapeJobs">> {
  const jobId = await ctx.db.insert("radarNicheScrapeJobs", {
    nicheId,
    terms,
    // Not claimable yet — enrichNicheScrapeTerms flips this to "pending"
    // (success or failure) once it's done expanding `terms` past the raw
    // keyword phrase.
    status: "enriching",
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.radar.geminiAds.enrichNicheScrapeTerms,
    {
      nicheId,
      jobId,
      description,
    },
  );
  // Best-effort: ping GitHub Actions to run the scrape worker now instead
  // of waiting for its 15-min poll — see githubDispatch.ts. No-ops silently
  // if GITHUB_ACTIONS_TOKEN isn't configured; the poll still covers it.
  await ctx.scheduler.runAfter(
    0,
    internal.radar.githubDispatch.dispatchScrapeWorkflow,
    {},
  );
  return jobId;
}

async function findExactNiche(
  ctx: MutationCtx,
  country: string,
  nicheKey: string,
): Promise<Id<"radarNiches"> | null> {
  if (!nicheKey) return null;
  const existing = await ctx.db
    .query("radarNiches")
    .withIndex("by_key", (q) => q.eq("country", country).eq("nicheKey", nicheKey))
    .unique();
  return existing?._id ?? null;
}

async function findSimilarNiche(
  ctx: MutationCtx,
  country: string,
  input: NicheInput,
): Promise<Id<"radarNiches"> | null> {
  const candidates = await ctx.db
    .query("radarNiches")
    .withIndex("by_country_updated", (q) => q.eq("country", country))
    .order("desc")
    .take(80);

  let bestId: Id<"radarNiches"> | null = null;
  let bestScore = 0;
  for (const niche of candidates) {
    const score = nicheSimilarity(input, { keywords: niche.keywords });
    if (score >= NICHE_REUSE_SIMILARITY_MIN && score > bestScore) {
      bestScore = score;
      bestId = niche._id;
    }
  }
  return bestId;
}

export async function enqueueScrapeIfNeeded(
  ctx: MutationCtx,
  nicheId: Id<"radarNiches">,
  description?: string,
): Promise<boolean> {
  const niche = await ctx.db.get(nicheId);
  if (!niche) return false;

  if (niche.status === "ready" && niche.adCount >= MIN_ADS_READY) return false;
  if (niche.status === "scraping") return false;

  // A job already in flight for this niche — enriching, waiting to be
  // claimed, or claimed — means don't queue a duplicate.
  for (const status of ["enriching", "pending", "claimed"] as const) {
    const existing = await ctx.db
      .query("radarNicheScrapeJobs")
      .withIndex("by_niche_status", (q) =>
        q.eq("nicheId", nicheId).eq("status", status),
      )
      .first();
    if (existing) return false;
  }

  await createScrapeJob(ctx, nicheId, jobTermsFromNiche(niche), description);

  if (niche.status !== "pending_scrape") {
    await ctx.db.patch(nicheId, {
      status: "pending_scrape",
      updatedAt: Date.now(),
    });
  }
  return true;
}

/**
 * Resolve an existing niche (exact key or Jaccard) or create one + scrape job.
 */
export async function resolveOrCreateNicheCore(
  ctx: MutationCtx,
  args: {
    keywords?: string[];
    description?: string;
    country?: string;
  },
): Promise<{
  nicheId: Id<"radarNiches">;
  created: boolean;
  reusedSimilar: boolean;
}> {
  const country = (args.country ?? AR).toUpperCase();
  const keywords = normalizeNicheKeywords(args.keywords);
  const input: NicheInput = {
    keywords,
    description: args.description,
  };
  const nicheKey = computeNicheKey(input);
  if (!nicheKey && keywords.length === 0) {
    throw new Error("Need niche keywords to resolve a niche bucket");
  }

  const exactId = await findExactNiche(ctx, country, nicheKey);
  if (exactId) {
    await enqueueScrapeIfNeeded(ctx, exactId, args.description);
    return { nicheId: exactId, created: false, reusedSimilar: false };
  }

  const similarId = await findSimilarNiche(ctx, country, input);
  if (similarId) {
    await enqueueScrapeIfNeeded(ctx, similarId, args.description);
    return { nicheId: similarId, created: false, reusedSimilar: true };
  }

  const now = Date.now();
  const label = keywords.join(", ") || "nicho";
  const nicheId = await ctx.db.insert("radarNiches", {
    country,
    nicheKey,
    keywords,
    label,
    adCount: 0,
    status: "pending_scrape",
    createdAt: now,
    updatedAt: now,
  });

  await createScrapeJob(
    ctx,
    nicheId,
    scrapeTermsForKeywords(keywords),
    args.description,
  );

  return { nicheId, created: true, reusedSimilar: false };
}

export const resolveOrCreateNiche = internalMutation({
  args: {
    keywords: v.optional(v.array(v.string())),
    description: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  returns: v.object({
    nicheId: v.id("radarNiches"),
    created: v.boolean(),
    reusedSimilar: v.boolean(),
  }),
  handler: async (ctx, args) => {
    return await resolveOrCreateNicheCore(ctx, args);
  },
});

export const getNiche = query({
  args: { nicheId: v.id("radarNiches") },
  returns: v.union(nicheReturnValidator, v.null()),
  handler: async (ctx, args) => {
    const niche = await ctx.db.get(args.nicheId);
    if (!niche) return null;
    return niche;
  },
});

/** Lazy-assign niche for users who onboarded before niche buckets existed. */
export const ensureMyNiche = mutation({
  args: {},
  returns: v.union(v.id("radarNiches"), v.null()),
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile) return null;
    if (profile.nicheId) {
      await enqueueScrapeIfNeeded(ctx, profile.nicheId);
      return profile.nicheId;
    }
    if (!(profile.nicheKeywords?.length || profile.description)) return null;
    const resolved = await resolveOrCreateNicheCore(ctx, {
      keywords: profile.nicheKeywords,
      description: profile.description,
      country: "AR",
    });
    await ctx.db.patch(profile._id, {
      nicheId: resolved.nicheId,
      updatedAt: Date.now(),
    });
    return resolved.nicheId;
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
 * Worker: force-queue scrape job(s) even if niche is already ready.
 * Pass nicheId for one niche, or omit to requeue recent AR niches.
 */
export const forceEnqueueScrapeJobs = mutation({
  args: {
    secret: v.string(),
    nicheId: v.optional(v.id("radarNiches")),
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
      const recent = await ctx.db
        .query("radarNiches")
        .withIndex("by_country_updated", (q) => q.eq("country", AR))
        .order("desc")
        .take(20);
      niches.push(...recent);
    }

    const now = Date.now();
    const nicheIds: Id<"radarNiches">[] = [];
    let enqueued = 0;

    for (const niche of niches) {
      // Unstick claimed (mid-scrape) or enriching (stuck term-expansion)
      // jobs so force can proceed.
      for (const status of ["claimed", "enriching"] as const) {
        const stuck = await ctx.db
          .query("radarNicheScrapeJobs")
          .withIndex("by_niche_status", (q) =>
            q.eq("nicheId", niche._id).eq("status", status),
          )
          .collect();
        for (const job of stuck) {
          await ctx.db.patch(job._id, {
            status: "failed",
            finishedAt: now,
            error: "superseded_by_force",
          });
        }
      }

      const pending = await ctx.db
        .query("radarNicheScrapeJobs")
        .withIndex("by_niche_status", (q) =>
          q.eq("nicheId", niche._id).eq("status", "pending"),
        )
        .first();
      if (pending) {
        nicheIds.push(niche._id);
        continue;
      }

      await createScrapeJob(ctx, niche._id, jobTermsFromNiche(niche));
      await ctx.db.patch(niche._id, {
        status: "pending_scrape",
        updatedAt: now,
      });
      nicheIds.push(niche._id);
      enqueued += 1;
    }

    return { enqueued, nicheIds };
  },
});

/**
 * Worker: claim next pending scrape job.
 *
 * Pass `nicheId` to claim that niche's job specifically instead of the
 * oldest pending job in the whole queue — without it, `--force-niche`
 * on the worker only *enqueues* the target niche's job; whichever job is
 * oldest overall still gets claimed first, silently scraping the wrong
 * niche if anything else was already pending.
 */
export const claimNextScrapeJob = mutation({
  args: { secret: v.string(), nicheId: v.optional(v.id("radarNiches")) },
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

    const job = args.nicheId
      ? await ctx.db
          .query("radarNicheScrapeJobs")
          .withIndex("by_niche_status", (q) =>
            q.eq("nicheId", args.nicheId!).eq("status", "pending"),
          )
          .first()
      : await ctx.db
          .query("radarNicheScrapeJobs")
          .withIndex("by_status_created", (q) => q.eq("status", "pending"))
          .order("asc")
          .first();
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
      country: niche.country,
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
          .take(500)
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

/**
 * Periodic sweep: re-enqueue any niche stuck below MIN_ADS_READY that isn't
 * already scraping or queued. Covers niches whose only scrape landed too few
 * gate-passing ads and that no new user has attached to since (previously
 * these only got re-enqueued when a new user joined the same niche).
 */
export const sweepUnderfilledNiches = internalMutation({
  args: {},
  returns: v.object({ enqueued: v.number() }),
  handler: async (ctx) => {
    const candidates = await ctx.db
      .query("radarNiches")
      .withIndex("by_status", (q) => q.eq("status", "pending_scrape"))
      .take(50);

    let enqueued = 0;
    for (const niche of candidates) {
      if (await enqueueScrapeIfNeeded(ctx, niche._id)) enqueued += 1;
    }
    return { enqueued };
  },
});

/**
 * Daily freshness sweep: re-enqueue every "ready" niche too, not just
 * under-filled ones — enqueueScrapeIfNeeded deliberately refuses to touch a
 * niche that's already ready (to avoid re-scraping on every user visit), so
 * without this a niche that reached "ready" once would never get scraped
 * again and could show increasingly stale ads indefinitely. Bounded to 200
 * niches per run — needs real pagination if the niche count grows well
 * past that.
 */
export const refreshAllReadyNiches = internalMutation({
  args: {},
  returns: v.object({ enqueued: v.number() }),
  handler: async (ctx) => {
    const readyNiches = await ctx.db
      .query("radarNiches")
      .withIndex("by_status", (q) => q.eq("status", "ready"))
      .take(200);

    let enqueued = 0;
    for (const niche of readyNiches) {
      let hasJobInFlight = false;
      for (const status of ["enriching", "pending", "claimed"] as const) {
        const existing = await ctx.db
          .query("radarNicheScrapeJobs")
          .withIndex("by_niche_status", (q) =>
            q.eq("nicheId", niche._id).eq("status", status),
          )
          .first();
        if (existing) {
          hasJobInFlight = true;
          break;
        }
      }
      if (hasJobInFlight) continue;

      await createScrapeJob(ctx, niche._id, jobTermsFromNiche(niche));
      await ctx.db.patch(niche._id, {
        status: "pending_scrape",
        updatedAt: Date.now(),
      });
      enqueued += 1;
    }
    return { enqueued };
  },
});
