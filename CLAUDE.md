# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## What this product does

TrendOS helps someone starting or running an ecommerce business in
**Argentina** answer "what should I sell?" by showing products that are
*already being advertised* on Meta (Facebook/Instagram) in AR. The MVP is
intentionally narrow: conversational onboarding → niche profile → Meta Ad
Library scrape → ad explorer UI. See `docs/product-context.md` (product
scope, in/out of MVP) and `docs/trend-radar.md` (data layer) — both are
short and worth reading before making architectural changes.

The codebase contains a much larger "Trend Radar" scoring/matching engine
(`radarProducts`, `radarProductScores`, marketplace/wholesale providers,
etc.) from an earlier product direction. It is **legacy, kept but not on
the MVP hot path** — don't extend it unless explicitly asked to; the live
product only uses the Meta Ad Library tables (`radarAds`,
`radarAdvertisers`, `radarStores`, `radarNiches*`) plus `businessProfiles`.

## Commands

```bash
npm run dev              # Next.js dev server
npx convex dev            # Convex dev (run alongside `npm run dev`, separate terminal)
npm run build             # Next.js production build
npm run lint               # eslint .
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run test:watch         # vitest watch mode
```

Run a single test file: `npx vitest run convex/radar/__tests__/radar.core.test.ts`.
Tests live under `**/__tests__/**/*.test.ts` (see `vitest.config.ts`).

Meta Ad Library scraper (Playwright, Argentina only, in `scripts/meta-ad-scraper/`):

```bash
npm run scrape:meta-ads              # claim pending niche scrape jobs from Convex, scrape, ingest
npm run scrape:meta-ads:queue        # same, explicit --queue
npm run scrape:meta-ads:seed         # ingest scripts/meta-ad-scraper/seed-sample.json (no browser)
npm run scrape:meta-ads -- --term "termo" --limit 30   # manual one-off debug scrape, no niche queue
npm run scrape:meta-ads -- --force   # re-scrape niches even if already "ready"
```

The scraper needs `META_ADS_INGEST_SECRET` and `CONVEX_URL` (or
`NEXT_PUBLIC_CONVEX_URL`) in the environment; it authenticates to Convex
mutations with that shared secret rather than a user session.

## Architecture

**Stack**: Next.js App Router (`src/app`) + Convex (`convex/`) + Clerk auth.
Clerk issues a JWT (template named `convex`) that Convex validates via
`convex/auth.config.ts`; `src/middleware.ts` protects all routes except
`/`, `/sign-in`, `/sign-up`.

**User → data flow (MVP hot path)**:
1. `/onboarding` collects goal, channels, niche keywords → written to
   `businessProfiles` (`convex/users.ts` / onboarding mutations).
2. A niche bucket is resolved or created (`convex/radar/niches.ts`,
   `resolveOrCreateNicheCore`): niche keywords are hashed into a
   `nicheKey` (`convex/lib/nicheProfile.ts`, `computeNicheKey`); an exact
   key match reuses the bucket, otherwise a Jaccard-similarity search
   (`nicheSimilarity`, threshold `NICHE_REUSE_SIMILARITY_MIN`) over recent
   niches reuses a *similar* bucket so ads are shared across stores with
   overlapping niches instead of re-scraping per user.
3. If the niche isn't `ready` with enough ads, a `radarNicheScrapeJobs` row
   is queued and `convex/radar/geminiAds.ts` (`enrichNicheScrapeTerms`)
   expands the niche into concrete Meta Ad Library search terms.
4. The external worker (`scripts/meta-ad-scraper/scrape.mjs`, Playwright)
   polls `claimNextScrapeJob`, scrapes `facebook.com/ads/library` for
   `country=AR`, and ingests results back into Convex
   (`radarAds`/`radarAdvertisers`/`radarStores`), then calls
   `completeScrapeJob`. Worker mutations authenticate via
   `META_ADS_INGEST_SECRET`, not a Clerk session — never gate them behind
   `requireCurrentUser`.
5. `/ads` (`src/app/ads/page.tsx`) queries ads for the user's niche and can
   request a personalized Gemini ranking (`refreshMyAdRanking`, cached in
   `radarAdRankings` keyed by niche + profile fingerprint).

**Source registry** (`convex/radar/providers/registry.ts`): every data
source (Meta Ad Library, Google Trends, Gemini, Mercado Libre, etc.) is
declared with required env vars and is **fail-closed** — a source without
credentials reports itself disabled/unusable rather than falling back to
mocked data. `TREND_RADAR_SOURCES` (default: `meta_ad_library` only)
controls what's enabled; Gemini/SerpAPI-backed sources are optional
enrichment, never required for the MVP path.

**Auth helpers** (`convex/lib/auth.ts`): use `requireCurrentUser`/
`getCurrentUserOrNull` (look up the `users` table by Clerk identity) inside
user-facing functions; use `requireIdentity` only when you need the raw
Clerk identity rather than the app's `users` doc.

**Niche matching** (`convex/lib/nicheProfile.ts`) implements lightweight
Spanish stemming (mate↔mates plural handling), Jaccard token similarity,
and keyword-substring relevance scoring — this is what filters/ranks ads
and marketplace candidates against a store's niche and exclusion list.
Changes here affect both niche bucket dedup *and* ad relevance filtering,
so check both call sites.

**HTTP helper** (`convex/radar/http.ts`): `fetchJsonWithRetry` (timeout +
exponential backoff on 429/5xx) and `createRateLimiter` (token bucket) are
the standard way to call external APIs from collectors/providers — use
them instead of raw `fetch` so rate-limit/retry behavior stays consistent,
and never log secrets through `structuredLog`.

**Admin**: `convex/admin/wipeAll.ts` is a dev-only destructive wipe of all
app tables, run via `npx convex run admin/wipeAll:wipeAll` with an explicit
confirm string — never call it as part of a normal task.

## Conventions

- Path alias `@/*` → `src/*` (see `tsconfig.json`); Convex-side imports
  under `convex/` use relative paths (no alias configured there).
- Convex functions return explicit `returns` validators (see any file in
  `convex/radar/`) — follow this pattern for new queries/mutations rather
  than leaving return types inferred.
- UI copy is in Spanish (Argentina) — match existing tone/language when
  editing `src/app/**` or `src/components/**`.
- This is **not** the Next.js you know — check
  `node_modules/next/dist/docs/` for this version's conventions before
  assuming training-data APIs still apply, per `AGENTS.md`.
