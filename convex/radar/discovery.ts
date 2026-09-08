/**
 * Product-first discovery & marketplace enrichment jobs.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeAlias, slugifyProductName } from "./normalize";
import { periodKeyFromTs } from "./metrics";
import { resolveSources } from "./providers/registry";
import { createMercadoLibreProvider } from "./providers/mercadolibre";
import { resolveMercadoLibreAccessToken } from "./providers/mlAuth";
import {
  searchAlibaba,
  searchMadeInChina,
} from "./providers/chinaB2b";
import { structuredLog } from "./http";
import type { DataSource } from "./validators";
import type { ExternalProduct } from "./contracts";
import {
  passesNicheFilter,
  type NicheInput,
} from "../lib/nicheProfile";
import {
  evidenceExternalId,
  isHttpUrl,
} from "./productEvidence";

/** Soft cap when accepting demand candidates without an agent run. */
const DEMAND_PRODUCT_CAP = 10;

type UpsertDemandArgs = {
  canonicalName: string;
  alias?: string;
  country?: string;
  searchInterest?: number;
  source: string;
  relatedQueriesJson?: string;
  geminiBuzz?: number;
  geminiMetadataJson?: string;
};

async function upsertDemandCandidateCore(
  ctx: MutationCtx,
  args: UpsertDemandArgs,
): Promise<Id<"radarProducts">> {
  const now = Date.now();
  const periodKey = periodKeyFromTs(now);
  const country = args.country ?? "AR";
  const normalized = normalizeAlias(args.canonicalName);
  const source = args.source as DataSource;

  const byAlias = await ctx.db
    .query("radarProductAliases")
    .withIndex("by_normalized", (q) => q.eq("normalizedAlias", normalized))
    .first();

  let productId: Id<"radarProducts">;
  if (byAlias) {
    productId = byAlias.productId;
    await ctx.db.patch(productId, {
      status: "tracked",
      updatedAt: now,
    });
  } else {
    const existing = await ctx.db
      .query("radarProducts")
      .withIndex("by_canonical", (q) =>
        q.eq("canonicalName", args.canonicalName),
      )
      .first();
    if (existing) {
      productId = existing._id;
      await ctx.db.patch(productId, { status: "tracked", updatedAt: now });
    } else {
      let slug = slugifyProductName(args.canonicalName);
      let n = 1;
      while (
        await ctx.db
          .query("radarProducts")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique()
      ) {
        slug = `${slugifyProductName(args.canonicalName)}-${n++}`;
      }
      productId = await ctx.db.insert("radarProducts", {
        canonicalName: args.canonicalName.slice(0, 120),
        slug,
        status: "tracked",
        country,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("radarProductAliases", {
        productId,
        alias: args.alias ?? args.canonicalName,
        normalizedAlias: normalized,
        source,
        createdAt: now,
      });
    }
  }

  if (
    args.searchInterest != null &&
    (source === "google_trends" || source === "trends_agent")
  ) {
    const existingSnap = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product_source_period", (q) =>
        q
          .eq("productId", productId)
          .eq("source", source)
          .eq("periodKey", periodKey),
      )
      .unique();
    if (!existingSnap) {
      await ctx.db.insert("radarProductSnapshots", {
        productId,
        source,
        capturedAt: now,
        periodKey,
        searchInterest: args.searchInterest,
        metadataJson: args.relatedQueriesJson,
      });
    }
  }

  if (
    args.geminiBuzz != null ||
    source === "gemini_research" ||
    source === "discovery_agent" ||
    source === "google_ads"
  ) {
    const buzz = args.geminiBuzz ?? args.searchInterest;
    const existingGemini = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product_source_period", (q) =>
        q
          .eq("productId", productId)
          .eq("source", source)
          .eq("periodKey", periodKey),
      )
      .unique();
    if (!existingGemini && buzz != null) {
      await ctx.db.insert("radarProductSnapshots", {
        productId,
        source,
        capturedAt: now,
        periodKey,
        searchInterest: buzz,
        metadataJson: args.geminiMetadataJson,
      });
    }
  }

  return productId;
}

export const upsertDemandCandidate = internalMutation({
  args: {
    canonicalName: v.string(),
    alias: v.optional(v.string()),
    country: v.optional(v.string()),
    searchInterest: v.optional(v.number()),
    source: v.string(),
    relatedQueriesJson: v.optional(v.string()),
    /** When source is gemini_research, persist buzz + citations on that source. */
    geminiBuzz: v.optional(v.number()),
    geminiMetadataJson: v.optional(v.string()),
  },
  returns: v.id("radarProducts"),
  handler: async (ctx, args) => {
    return await upsertDemandCandidateCore(ctx, args);
  },
});

const acceptResultValidator = v.object({
  skipped: v.boolean(),
  reason: v.optional(v.string()),
  productId: v.optional(v.id("radarProducts")),
});

/**
 * Niche-filtered demand candidate upsert (no agent run).
 */
export const acceptDemandCandidate = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    canonicalName: v.string(),
    alias: v.optional(v.string()),
    country: v.optional(v.string()),
    searchInterest: v.optional(v.number()),
    source: v.string(),
    relatedQueriesJson: v.optional(v.string()),
    geminiBuzz: v.optional(v.number()),
    geminiMetadataJson: v.optional(v.string()),
  },
  returns: acceptResultValidator,
  handler: async (ctx, args) => {
    const tracked = await ctx.db
      .query("radarProducts")
      .withIndex("by_status", (q) => q.eq("status", "tracked"))
      .take(DEMAND_PRODUCT_CAP + 1);
    if (tracked.length >= DEMAND_PRODUCT_CAP) {
      return { skipped: true, reason: "product_cap" };
    }

    // Legacy discovery path (not on the MVP hot path — see CLAUDE.md): a
    // store's niche is now a fixed catalog pick, not typed keywords/
    // exclusions, so this filter degrades to description-only signal.
    let niche: NicheInput = {};
    if (args.userId) {
      const profile = await ctx.db
        .query("businessProfiles")
        .withIndex("by_user", (q) => q.eq("userId", args.userId!))
        .unique();
      if (profile) {
        niche = { description: profile.description };
      }
    }

    if (!passesNicheFilter(args.canonicalName, niche)) {
      return { skipped: true, reason: "niche_filter" };
    }

    const productId = await upsertDemandCandidateCore(ctx, {
      canonicalName: args.canonicalName,
      alias: args.alias,
      country: args.country,
      searchInterest: args.searchInterest,
      source: args.source,
      relatedQueriesJson: args.relatedQueriesJson,
      geminiBuzz: args.geminiBuzz,
      geminiMetadataJson: args.geminiMetadataJson,
    });

    return { skipped: false, productId };
  },
});

export const listCandidateProducts = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("radarProducts"),
      canonicalName: v.string(),
      status: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const tracked = await ctx.db
      .query("radarProducts")
      .withIndex("by_status", (q) => q.eq("status", "tracked"))
      .take(args.limit ?? 100);
    const pending = await ctx.db
      .query("radarProducts")
      .withIndex("by_status", (q) => q.eq("status", "pending_review"))
      .take(args.limit ?? 50);
    return [...tracked, ...pending].map((p) => ({
      _id: p._id,
      canonicalName: p.canonicalName,
      status: p.status,
    }));
  },
});

/**
 * Attach clickable source URLs to an existing product (Gemini / web evidence).
 * Does not create a new product via fuzzy title matching.
 */
export const attachEvidenceListings = internalMutation({
  args: {
    productId: v.id("radarProducts"),
    source: v.string(),
    title: v.string(),
    urls: v.array(v.string()),
    country: v.optional(v.string()),
    /** Research image URL — kept only inside listing metadataJson (no schema field). */
    imageUrl: v.optional(v.string()),
  },
  returns: v.object({ attached: v.number() }),
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) return { attached: 0 };

    const source = args.source as DataSource;
    const now = Date.now();
    const periodKey = periodKeyFromTs(now);
    let attached = 0;
    const imageUrl =
      args.imageUrl && isHttpUrl(args.imageUrl) ? args.imageUrl.trim() : undefined;

    const uniqueUrls = [...new Set(args.urls.map((u) => u.trim()))]
      .filter(isHttpUrl)
      .slice(0, 5);

    for (const url of uniqueUrls) {
      const externalId = evidenceExternalId(url);
      const existing = await ctx.db
        .query("radarMarketplaceListings")
        .withIndex("by_source_external", (q) =>
          q.eq("source", source).eq("externalId", externalId),
        )
        .unique();

      const meta = JSON.stringify({
        kind: "evidence_url",
        ...(imageUrl ? { imageUrl } : {}),
      });

      let listingId: Id<"radarMarketplaceListings">;
      if (existing) {
        await ctx.db.patch(existing._id, {
          productId: args.productId,
          title: args.title.slice(0, 200),
          externalUrl: url,
          lastSeenAt: now,
          isActive: true,
          metadataJson: meta,
        });
        listingId = existing._id;
      } else {
        listingId = await ctx.db.insert("radarMarketplaceListings", {
          productId: args.productId,
          source,
          externalId,
          externalUrl: url,
          title: args.title.slice(0, 200),
          firstSeenAt: now,
          lastSeenAt: now,
          isActive: true,
          metadataJson: meta,
        });
      }

      const existingSnap = await ctx.db
        .query("radarProductSnapshots")
        .withIndex("by_product_source_period", (q) =>
          q
            .eq("productId", args.productId)
            .eq("source", source)
            .eq("periodKey", periodKey),
        )
        .unique();
      if (!existingSnap) {
        await ctx.db.insert("radarProductSnapshots", {
          productId: args.productId,
          listingId,
          source,
          capturedAt: now,
          periodKey,
          listingCount: 1,
          metadataJson: JSON.stringify({
            evidenceUrl: url,
            ...(imageUrl ? { imageUrl } : {}),
          }),
        });
      }
      attached += 1;
    }

    return { attached };
  },
});

export const listActiveWholesaleOffers = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("radarWholesaleOffers"),
      sku: v.string(),
      title: v.string(),
      normalizedTitle: v.string(),
      normalizedAliases: v.array(v.string()),
      unitPrice: v.number(),
      currency: v.string(),
      moq: v.optional(v.number()),
      leadTimeDays: v.optional(v.number()),
      externalUrl: v.optional(v.string()),
      productId: v.optional(v.id("radarProducts")),
    }),
  ),
  handler: async (ctx) => {
    const offers = await ctx.db
      .query("radarWholesaleOffers")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
    return offers.map((o) => ({
      _id: o._id,
      sku: o.sku,
      title: o.title,
      normalizedTitle: o.normalizedTitle,
      normalizedAliases: o.normalizedAliases,
      unitPrice: o.unitPrice,
      currency: o.currency,
      moq: o.moq,
      leadTimeDays: o.leadTimeDays,
      externalUrl: o.externalUrl,
      productId: o.productId,
    }));
  },
});

export const linkWholesaleToProduct = internalMutation({
  args: {
    offerId: v.id("radarWholesaleOffers"),
    productId: v.id("radarProducts"),
    unitPrice: v.number(),
    currency: v.string(),
    moq: v.optional(v.number()),
    leadTimeDays: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const periodKey = periodKeyFromTs(now);
    await ctx.db.patch(args.offerId, {
      productId: args.productId,
      updatedAt: now,
    });

    const listingExternalId = `WHOLESALE-${args.offerId}`;
    let listing = await ctx.db
      .query("radarMarketplaceListings")
      .withIndex("by_source_external", (q) =>
        q.eq("source", "wholesale").eq("externalId", listingExternalId),
      )
      .unique();
    if (!listing) {
      const offer = await ctx.db.get(args.offerId);
      const listingId = await ctx.db.insert("radarMarketplaceListings", {
        productId: args.productId,
        source: "wholesale",
        externalId: listingExternalId,
        externalUrl: offer?.externalUrl,
        title: offer?.title ?? "Wholesale offer",
        currency: args.currency,
        currentPrice: args.unitPrice,
        availableQuantity: args.moq,
        firstSeenAt: now,
        lastSeenAt: now,
        isActive: true,
        metadataJson: JSON.stringify({
          moq: args.moq ?? null,
          leadTimeDays: args.leadTimeDays ?? null,
        }),
      });
      listing = await ctx.db.get(listingId);
    } else {
      await ctx.db.patch(listing._id, {
        productId: args.productId,
        currentPrice: args.unitPrice,
        lastSeenAt: now,
        isActive: true,
      });
    }

    const snapExists = await ctx.db
      .query("radarProductSnapshots")
      .withIndex("by_product_source_period", (q) =>
        q
          .eq("productId", args.productId)
          .eq("source", "wholesale")
          .eq("periodKey", periodKey),
      )
      .unique();
    if (!snapExists) {
      await ctx.db.insert("radarProductSnapshots", {
        productId: args.productId,
        listingId: listing?._id,
        source: "wholesale",
        capturedAt: now,
        periodKey,
        price: args.unitPrice,
        listingCount: 1,
        availableQuantity: args.moq,
        metadataJson: JSON.stringify({
          leadTimeDays: args.leadTimeDays ?? null,
        }),
      });
    }
    return null;
  },
});

async function upsertExternalProducts(
  ctx: {
    runMutation: (
      mutation: typeof internal.radar.jobs.upsertListingAndSnapshot,
      args: {
        source: string;
        externalId: string;
        title: string;
        externalUrl?: string;
        price?: number;
        originalPrice?: number;
        currency?: string;
        sellerId?: string;
        sellerName?: string;
        availableQuantity?: number;
        condition?: string;
        categoryExternalId?: string;
        soldQuantity?: number;
        reviewCount?: number;
        rating?: number;
        searchPosition?: number;
        listingCount?: number;
        metadataJson?: string;
        country?: string;
      },
    ) => Promise<unknown>;
  },
  items: ExternalProduct[],
  country: string,
): Promise<void> {
  for (const item of items) {
    await ctx.runMutation(internal.radar.jobs.upsertListingAndSnapshot, {
      source: item.source,
      externalId: item.externalId,
      title: item.title,
      externalUrl: item.externalUrl,
      price: item.price,
      originalPrice: item.originalPrice,
      currency: item.currency,
      sellerId: item.sellerId,
      sellerName: item.sellerName,
      availableQuantity: item.availableQuantity,
      condition: item.condition,
      categoryExternalId: item.categoryExternalId,
      soldQuantity: item.soldQuantity,
      reviewCount: item.reviewCount,
      rating: item.rating,
      searchPosition: item.searchPosition,
      listingCount: 1,
      metadataJson: item.metadata
        ? JSON.stringify(item.metadata)
        : undefined,
      country,
    });
  }
}

/** Search Mercado Libre + China B2B light fetch for each candidate. */
export const runEnrichFromMarketplaces = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    let processed = 0;
    let successful = 0;
    let failed = 0;
    const errors: string[] = [];

    try {
      const sources = resolveSources();
      const products: Array<{
        _id: Id<"radarProducts">;
        canonicalName: string;
      }> = await ctx.runQuery(internal.radar.discovery.listCandidateProducts, {
        limit: 50,
      });

      let mlProvider = null as ReturnType<
        typeof createMercadoLibreProvider
      > | null;

      const mlSrc = sources.find((s) => s.id === "mercadolibre");
      if (mlSrc?.enabled) {
        if (!mlSrc.configured) {
          errors.push(`mercadolibre disabled: ${mlSrc.missingEnv.join(", ")}`);
        } else {
          const token = await resolveMercadoLibreAccessToken(ctx);
          mlProvider = createMercadoLibreProvider({
            accessToken: token,
            jobId: args.jobId,
          });
        }
      }

      const micEnabled =
        sources.find((s) => s.id === "made_in_china")?.usable ?? false;
      const aliEnabled =
        sources.find((s) => s.id === "alibaba")?.usable ?? false;

      if (!mlProvider && !micEnabled && !aliEnabled) {
        throw new Error(
          "No enrich sources usable. Enable made_in_china and/or alibaba in TREND_RADAR_SOURCES (Mercado Libre optional).",
        );
      }

      const country = process.env.TREND_RADAR_COUNTRY ?? "AR";

      for (const product of products) {
        processed += 1;
        try {
          if (mlProvider) {
            const mlResult = await mlProvider.searchProducts?.({
              query: product.canonicalName,
              country,
              limit: 8,
            });
            await upsertExternalProducts(
              ctx,
              mlResult?.items ?? [],
              country,
            );
            for (const err of mlResult?.errors ?? []) {
              errors.push(`ML: ${err.message}`);
              failed += 1;
            }
          }

          if (micEnabled) {
            const mic = await searchMadeInChina(product.canonicalName, {
              limit: 5,
              jobId: args.jobId,
            });
            await upsertExternalProducts(ctx, mic.items, country);
            for (const err of mic.errors) {
              errors.push(err.message);
              if (err.errorType === "blocked" || err.errorType === "parse_empty") {
                // soft — don't inflate failed product count hard
              } else {
                failed += 1;
              }
            }
          }

          if (aliEnabled) {
            const ali = await searchAlibaba(product.canonicalName, {
              limit: 5,
              jobId: args.jobId,
            });
            await upsertExternalProducts(ctx, ali.items, country);
            for (const err of ali.errors) {
              errors.push(err.message);
            }
          }

          successful += 1;
        } catch (e) {
          failed += 1;
          errors.push(e instanceof Error ? e.message : "enrich failed");
          structuredLog({
            jobId: args.jobId,
            productId: product._id,
            errorType: "enrich_error",
            message: e instanceof Error ? e.message : "error",
          });
        }
      }

      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: failed > 0 || errors.length > 0
          ? "COMPLETED_WITH_ERRORS"
          : "COMPLETED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed,
        errorSummary: errors.slice(0, 5).join("; ") || undefined,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed + 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});

/** Link imported wholesale offers to products by alias/title. */
export const runEnrichFromWholesale = internalAction({
  args: { jobId: v.id("radarJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.radar.jobs.markJobRunning, {
      jobId: args.jobId,
    });
    let processed = 0;
    let successful = 0;
    let failed = 0;

    try {
      const offers = await ctx.runQuery(
        internal.radar.discovery.listActiveWholesaleOffers,
        {},
      );
      const products = await ctx.runQuery(
        internal.radar.discovery.listCandidateProducts,
        { limit: 200 },
      );

      for (const offer of offers) {
        processed += 1;
        try {
          if (offer.productId) {
            await ctx.runMutation(internal.radar.discovery.linkWholesaleToProduct, {
              offerId: offer._id,
              productId: offer.productId,
              unitPrice: offer.unitPrice,
              currency: offer.currency,
              moq: offer.moq,
              leadTimeDays: offer.leadTimeDays,
            });
            successful += 1;
            continue;
          }

          const keys = [
            offer.normalizedTitle,
            ...offer.normalizedAliases,
          ].filter(Boolean);

          let matched: Id<"radarProducts"> | null = null;
          for (const product of products) {
            const pNorm = normalizeAlias(product.canonicalName);
            if (keys.some((k) => k === pNorm || pNorm.includes(k) || k.includes(pNorm))) {
              matched = product._id;
              break;
            }
          }

          if (!matched) {
            // Create product from wholesale title (sourcing-first candidate)
            matched = await ctx.runMutation(
              internal.radar.discovery.upsertDemandCandidate,
              {
                canonicalName: offer.title,
                source: "wholesale",
                country: process.env.TREND_RADAR_COUNTRY ?? "AR",
              },
            );
          }

          await ctx.runMutation(internal.radar.discovery.linkWholesaleToProduct, {
            offerId: offer._id,
            productId: matched,
            unitPrice: offer.unitPrice,
            currency: offer.currency,
            moq: offer.moq,
            leadTimeDays: offer.leadTimeDays,
          });
          successful += 1;
        } catch (e) {
          failed += 1;
          structuredLog({
            jobId: args.jobId,
            source: "wholesale",
            errorType: "wholesale_link_error",
            message: e instanceof Error ? e.message : "error",
          });
        }
      }

      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed,
      });
    } catch (e) {
      await ctx.runMutation(internal.radar.jobs.finishJob, {
        jobId: args.jobId,
        status: "FAILED",
        processedItems: processed,
        successfulItems: successful,
        failedItems: failed + 1,
        errorSummary: e instanceof Error ? e.message : "failed",
      });
    }
    return null;
  },
});
