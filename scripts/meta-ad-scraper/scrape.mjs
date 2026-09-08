/**
 * Meta Ad Library scraper — Argentina only.
 *
 * Default: claim pending niche scrape jobs from Convex and ingest into that niche.
 *
 *   META_ADS_INGEST_SECRET=... CONVEX_URL=... npm run scrape:meta-ads
 *
 * Force re-scrape (even if niche already ready):
 *   npm run scrape:meta-ads -- --force
 *   npm run scrape:meta-ads -- --force-niche "<nicheId>"
 *
 * Manual debug (no niche queue):
 *   npm run scrape:meta-ads -- --term "termo" --limit 30
 *   npm run scrape:meta-ads -- --term "termo" --niche-id "<id>"
 *
 * Optional: META_ADS_PROXY_SERVER, META_ADS_HEADED=1, META_ADS_DEBUG=1, --seed
 */

import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const COUNTRY = "AR";

/**
 * Target ads per niche job. Raised from the original 15 — at 15, the first
 * one or two productive search terms routinely ate the whole budget before
 * the rest of Gemini's ~10 generated terms (covering different sub-products)
 * ever ran, which is what made niche feeds feel narrow. 50 gives enough
 * headroom for scrapeTerms' round-robin pass to actually cover most terms.
 */
const DEFAULT_NICHE_AD_TARGET = 50;

function parseArgs(argv) {
  const out = {
    terms: [],
    limit: DEFAULT_NICHE_AD_TARGET,
    seedFile: process.env.META_ADS_SEED_FILE,
    nicheId: undefined,
    queue: true,
    maxJobs: 3,
    force: false,
    forceNicheId: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--term" && argv[i + 1]) {
      out.terms.push(argv[++i]);
      out.queue = false;
    } else if (a === "--limit" && argv[i + 1]) {
      out.limit = Number(argv[++i]) || 40;
    } else if (a === "--seed" && argv[i + 1]) {
      out.seedFile = argv[++i];
      out.queue = false;
    } else if (a === "--niche-id" && argv[i + 1]) {
      out.nicheId = argv[++i];
    } else if (a === "--queue") {
      out.queue = true;
    } else if (a === "--no-queue") {
      out.queue = false;
    } else if (a === "--max-jobs" && argv[i + 1]) {
      out.maxJobs = Number(argv[++i]) || 3;
    } else if (a === "--force") {
      out.force = true;
      out.queue = true;
    } else if (a === "--force-niche" && argv[i + 1]) {
      out.force = true;
      out.forceNicheId = argv[++i];
      out.queue = true;
    }
  }
  return out;
}

function clientAndSecret() {
  const url = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.META_ADS_INGEST_SECRET;
  if (!url || !secret) {
    throw new Error("CONVEX_URL and META_ADS_INGEST_SECRET are required");
  }
  return { client: new ConvexHttpClient(url), secret };
}

function libraryUrl(term) {
  const q = encodeURIComponent(term);
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${COUNTRY}&q=${q}&search_type=keyword_unordered&media_type=all`;
}

function asText(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.text === "string") {
    return value.text;
  }
  return undefined;
}

/** Drop empty / dynamic catalog placeholders like {{product.brand}}. */
function cleanCopy(value) {
  const text = asText(value)?.trim();
  if (!text) return undefined;
  if (/\{\{\s*[\w.]+\s*\}\}/.test(text)) return undefined;
  return text;
}

function pushHttpUrl(list, url) {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    list.push(url);
  }
}

/** Meta puts creatives in images, videos, cards, extras — not just images[]. */
function collectMediaUrls(snap) {
  const mediaUrls = [];
  for (const img of snap.images ?? []) {
    pushHttpUrl(mediaUrls, img?.original_image_url);
    pushHttpUrl(mediaUrls, img?.resized_image_url);
    pushHttpUrl(mediaUrls, img?.watermarked_resized_image_url);
    pushHttpUrl(mediaUrls, img?.url);
  }
  for (const vid of snap.videos ?? []) {
    pushHttpUrl(mediaUrls, vid?.video_preview_image_url);
  }
  for (const card of snap.cards ?? []) {
    pushHttpUrl(mediaUrls, card?.original_image_url);
    pushHttpUrl(mediaUrls, card?.resized_image_url);
    pushHttpUrl(mediaUrls, card?.video_preview_image_url);
    pushHttpUrl(mediaUrls, card?.watermarked_resized_image_url);
  }
  for (const img of snap.extra_images ?? []) {
    pushHttpUrl(mediaUrls, img?.original_image_url);
    pushHttpUrl(mediaUrls, img?.resized_image_url);
  }
  for (const vid of snap.extra_videos ?? []) {
    pushHttpUrl(mediaUrls, vid?.video_preview_image_url);
  }
  pushHttpUrl(mediaUrls, snap.video_preview_image_url);
  return [...new Set(mediaUrls)].slice(0, 5);
}

/** Prefer SD for lighter hover previews in the feed. */
function collectVideoUrl(snap) {
  const candidates = [];
  for (const vid of snap.videos ?? []) {
    candidates.push(
      vid?.video_sd_url,
      vid?.video_hd_url,
      vid?.watermarked_video_sd_url,
      vid?.watermarked_video_hd_url,
    );
  }
  for (const card of snap.cards ?? []) {
    candidates.push(card?.video_sd_url, card?.video_hd_url);
  }
  for (const vid of snap.extra_videos ?? []) {
    candidates.push(
      vid?.video_sd_url,
      vid?.video_hd_url,
      vid?.watermarked_video_sd_url,
    );
  }
  for (const url of candidates) {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return undefined;
}

function collectBody(snap) {
  const primary =
    cleanCopy(snap.body) ??
    cleanCopy(snap.body_text) ??
    cleanCopy(snap.title);
  if (primary) return primary;
  for (const card of snap.cards ?? []) {
    const fromCard =
      cleanCopy(card?.body) ?? cleanCopy(card?.title) ?? cleanCopy(card?.link_description);
    if (fromCard) return fromCard;
  }
  return cleanCopy(snap.link_description) ?? cleanCopy(snap.caption);
}

function normalizeAd(node, term) {
  const collated = node?.collated_results?.[0];
  const base = collated ?? node;
  if (!base) return null;

  const archiveId = String(
    base.ad_archive_id ?? base.adArchiveId ?? base.id ?? "",
  );
  if (!archiveId) return null;

  const snap = base.snapshot ?? {};
  const pageName =
    cleanCopy(snap.page_name) ??
    cleanCopy(base.page_name) ??
    cleanCopy(snap.pageName) ??
    "Unknown page";
  const pageId = String(
    snap.page_id ?? base.page_id ?? snap.pageId ?? archiveId,
  );
  const body = collectBody(snap);
  const cta = snap.cta_text ?? snap.cta_type ?? undefined;
  const destinationUrl =
    snap.link_url ??
    (snap.cards?.[0]?.link_url) ??
    (typeof snap.caption === "string" && snap.caption.startsWith("http")
      ? snap.caption
      : undefined);

  const mediaUrls = collectMediaUrls(snap);
  const videoUrl = collectVideoUrl(snap);

  const platforms = Array.isArray(base.publisher_platform)
    ? base.publisher_platform
    : ["facebook"];

  const startRaw = base.start_date ?? base.startDate;
  let startedAt;
  if (typeof startRaw === "number") {
    startedAt = startRaw < 1e12 ? startRaw * 1000 : startRaw;
  }

  return {
    externalAdId: archiveId,
    pageId,
    pageName: String(pageName).slice(0, 120),
    platforms,
    body: body?.slice(0, 2000),
    cta: cta ? String(cta).slice(0, 120) : undefined,
    snapshotUrl: `https://www.facebook.com/ads/library/?id=${archiveId}`,
    mediaUrls,
    videoUrl,
    destinationUrl:
      typeof destinationUrl === "string" && destinationUrl.startsWith("http")
        ? destinationUrl
        : undefined,
    searchTerm: term,
    isActive: base.is_active ?? true,
    startedAt,
  };
}

function walkForAds(value, term, out, seen) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) walkForAds(item, term, out, seen);
    return;
  }

  if (value.ad_archive_id || value.adArchiveId) {
    const ad = normalizeAd(value, term);
    if (ad && !seen.has(ad.externalAdId)) {
      seen.add(ad.externalAdId);
      out.push(ad);
    }
  }

  if (Array.isArray(value.edges)) {
    for (const edge of value.edges) {
      const node = edge?.node;
      if (!node) continue;
      if (Array.isArray(node.collated_results)) {
        for (const c of node.collated_results) {
          const ad = normalizeAd(
            { ...node, ...c, collated_results: [c] },
            term,
          );
          if (ad && !seen.has(ad.externalAdId)) {
            seen.add(ad.externalAdId);
            out.push(ad);
          }
        }
      } else {
        const ad = normalizeAd(node, term);
        if (ad && !seen.has(ad.externalAdId)) {
          seen.add(ad.externalAdId);
          out.push(ad);
        }
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (key === "extensions") continue;
    walkForAds(value[key], term, out, seen);
  }
}

function extractAdsFromGraphqlJson(json, term) {
  const out = [];
  const seen = new Set();
  const payloads = Array.isArray(json) ? json : [json];
  for (const payload of payloads) {
    walkForAds(payload, term, out, seen);
  }
  return out;
}

async function scrapeTerm(page, term, limit, debug) {
  const url = libraryUrl(term);
  console.log(`Opening ${url}`);

  const collected = [];
  const seen = new Set();
  let graphqlHits = 0;

  const onResponse = async (res) => {
    try {
      const resUrl = res.url();
      if (!resUrl.includes("/api/graphql")) return;
      if (res.status() < 200 || res.status() >= 300) return;
      graphqlHits += 1;
      let text;
      try {
        text = await res.text();
      } catch {
        return;
      }
      if (!text || text.length < 20) return;
      const chunks = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const chunk of chunks) {
        let json;
        try {
          json = JSON.parse(chunk);
        } catch {
          continue;
        }
        for (const ad of extractAdsFromGraphqlJson(json, term)) {
          if (seen.has(ad.externalAdId)) continue;
          seen.add(ad.externalAdId);
          collected.push(ad);
        }
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", onResponse);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);

  for (const label of [
    "Allow all cookies",
    "Permitir todas las cookies",
    "Accept all",
    "Aceptar todo",
  ]) {
    try {
      const btn = page.getByRole("button", { name: label });
      if (await btn.count()) {
        await btn.first().click({ timeout: 2000 });
        await page.waitForTimeout(1000);
      }
    } catch {
      /* ignore */
    }
  }

  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 3200);
    await page.waitForTimeout(1500);
    if (collected.length >= limit) break;
  }
  await page.waitForTimeout(2500);
  page.off("response", onResponse);

  if (debug) {
    const dir = resolve("scripts/meta-ad-scraper/debug");
    mkdirSync(dir, { recursive: true });
    const safe = term.replace(/\W+/g, "_").slice(0, 40);
    writeFileSync(resolve(dir, `${safe}.html`), await page.content(), "utf8");
    console.log(`  debug: graphqlHits=${graphqlHits}`);
  }

  const ads = collected.slice(0, limit);
  console.log(
    `  → ${ads.length} ads for "${term}" (graphql responses: ${graphqlHits})`,
  );
  // Meta responded substantially but nothing was extractable — genuinely
  // sparse results don't usually generate this much graphql traffic for
  // nothing. Confirmed on 2026-09-07: a CI-run scraper hit this pattern
  // across most terms while the identical terms run locally returned real
  // ads, consistent with the runner's IP/environment getting a degraded
  // response Meta doesn't serve to a normal browser session.
  if (ads.length === 0 && graphqlHits >= 10) {
    console.warn(
      `  ⚠ "${term}": ${graphqlHits} graphql responses yielded 0 ads — possible degraded/blocked response, not necessarily "no results". Re-run with META_ADS_DEBUG=1 to inspect.`,
    );
  }
  return ads;
}

async function ingest(ads, nicheId) {
  const { client, secret } = clientAndSecret();
  const result = await client.mutation(
    anyApi.radar.metaAds.ingestScrapedAdsFromWorker,
    {
      secret,
      country: COUNTRY,
      nicheId,
      ads,
    },
  );
  console.log("Ingest result:", result);
  return result;
}

async function launchBrowser() {
  const proxy = process.env.META_ADS_PROXY_SERVER;
  const headed = process.env.META_ADS_HEADED === "1";
  const browser = await chromium.launch({
    headless: !headed,
    proxy: proxy ? { server: proxy } : undefined,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    locale: "es-AR",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 960 },
    extraHTTPHeaders: {
      "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return { browser, page: await context.newPage() };
}

/**
 * Two passes. First, round-robin with a per-term cap so one generic,
 * high-volume term (e.g. "mancuernas") can't consume the entire niche
 * budget and starve the other Gemini-generated terms that cover different
 * sub-products — that's what was making niche feeds feel narrow even with
 * a diverse term list. Second, an uncapped pass over the same terms to
 * spend any budget a dead term (0 results) left unused, so raising the cap
 * for diversity doesn't cost total volume.
 */
async function scrapeTerms(page, terms, limit, debug) {
  const byId = new Map();
  const perTermCap = Math.max(6, Math.ceil(limit / terms.length) + 2);
  // Track which terms actually returned something in pass 1 — a term that
  // came back with 0 after a full scroll (scrapeTerm always runs its full
  // iteration budget when nothing is found) is very unlikely to produce
  // something different a few minutes later. Blindly re-visiting EVERY term
  // in the fill pass — most niches have far more dead terms than productive
  // ones — was silently doubling the scrape's wall-clock time for no gain.
  const productiveTerms = new Set();

  for (const term of terms) {
    if (byId.size >= limit) break;
    const remaining = limit - byId.size;
    const termLimit = Math.min(perTermCap, remaining);
    try {
      const batch = await scrapeTerm(page, term, termLimit, debug);
      if (batch.length > 0) productiveTerms.add(term);
      for (const ad of batch) {
        if (!byId.has(ad.externalAdId)) byId.set(ad.externalAdId, ad);
      }
    } catch (err) {
      console.warn(`Term "${term}" failed:`, err.message);
    }
  }

  if (byId.size < limit) {
    for (const term of terms) {
      if (byId.size >= limit) break;
      if (!productiveTerms.has(term)) continue; // confirmed dead in pass 1
      const remaining = limit - byId.size;
      try {
        const batch = await scrapeTerm(page, term, remaining, debug);
        for (const ad of batch) {
          if (!byId.has(ad.externalAdId)) byId.set(ad.externalAdId, ad);
        }
      } catch (err) {
        console.warn(`Term "${term}" (fill pass) failed:`, err.message);
      }
    }
  }

  return [...byId.values()].slice(0, limit);
}

async function forceEnqueue(nicheId) {
  const { client, secret } = clientAndSecret();
  const result = await client.mutation(
    anyApi.radar.niches.forceEnqueueScrapeJobs,
    { secret, nicheId },
  );
  console.log(
    `Force-enqueued ${result.enqueued} job(s) for ${result.nicheIds.length} niche(s).`,
  );
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A freshly (force-)enqueued job starts "enriching" — not yet claimable —
 * until Gemini finishes expanding its search terms (convex/radar/niches.ts
 * createScrapeJob, convex/radar/geminiAds.ts enrichNicheScrapeTerms).
 * That's usually a few seconds but can take up to ~80s in the worst case
 * (retries on a slow Gemini response). Claiming exactly once right after
 * forceEnqueue() reliably lost this race — "Force-enqueued 1 job(s)"
 * immediately followed by "No pending niche scrape jobs." — so retry with
 * backoff instead of giving up on the very first attempt.
 */
async function claimWithRetryForForce(client, secret, targetNicheId) {
  const maxWaitMs = 90_000;
  let delayMs = 2_000;
  const start = Date.now();
  for (;;) {
    const job = await client.mutation(anyApi.radar.niches.claimNextScrapeJob, {
      secret,
      nicheId: targetNicheId,
    });
    if (job) return job;
    if (Date.now() - start >= maxWaitMs) return null;
    console.log(
      `  Job still enriching search terms, retrying in ${delayMs / 1000}s...`,
    );
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 1.5, 8_000);
  }
}

async function runQueue(args, debug) {
  const { client, secret } = clientAndSecret();
  // --force-niche means "run this niche" — claim its job specifically so an
  // older pending job for some other niche can't get scraped instead.
  const targetNicheId = args.force
    ? args.forceNicheId || args.nicheId
    : undefined;
  if (args.force) {
    await forceEnqueue(targetNicheId);
  }
  const { browser, page } = await launchBrowser();
  let processed = 0;
  try {
    for (let i = 0; i < args.maxJobs; i++) {
      const job =
        args.force && i === 0
          ? await claimWithRetryForForce(client, secret, targetNicheId)
          : await client.mutation(anyApi.radar.niches.claimNextScrapeJob, {
              secret,
              nicheId: targetNicheId,
            });
      if (!job) {
        console.log(i === 0 ? "No pending niche scrape jobs." : "Queue empty.");
        break;
      }
      console.log(
        `Job ${job.jobId} niche=${job.label} terms=${job.terms.join(", ")}`,
      );
      try {
        const ads = await scrapeTerms(page, job.terms, args.limit, debug);
        if (ads.length === 0) {
          await client.mutation(anyApi.radar.niches.completeScrapeJob, {
            secret,
            jobId: job.jobId,
            ok: false,
            error: "zero_ads",
          });
          console.warn("  zero ads — marked failed (retry later via new job)");
        } else {
          await ingest(ads, job.nicheId);
          await client.mutation(anyApi.radar.niches.completeScrapeJob, {
            secret,
            jobId: job.jobId,
            ok: true,
          });
        }
        processed += 1;
      } catch (err) {
        await client.mutation(anyApi.radar.niches.completeScrapeJob, {
          secret,
          jobId: job.jobId,
          ok: false,
          error: err.message,
        });
        console.warn(`  job failed: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Processed ${processed} niche job(s).`);
}

async function main() {
  const args = parseArgs(process.argv);
  const debug = process.env.META_ADS_DEBUG === "1";

  if (args.seedFile) {
    const path = resolve(args.seedFile);
    const ads = JSON.parse(readFileSync(path, "utf8"));
    console.log(`Loaded ${ads.length} ads from seed ${path}`);
    await ingest(ads, args.nicheId);
    return;
  }

  if (args.queue && args.terms.length === 0) {
    await runQueue(args, debug);
    return;
  }

  if (args.terms.length === 0) {
    console.error("Pass --term or use default queue mode without --term.");
    process.exit(1);
  }

  const { browser, page } = await launchBrowser();
  try {
    const unique = await scrapeTerms(page, args.terms, args.limit, debug);
    console.log(`Total unique ads: ${unique.length}`);
    if (unique.length === 0) {
      console.warn("No ads scraped. Try META_ADS_HEADED=1 or a residential proxy.");
      process.exitCode = 2;
      return;
    }
    await ingest(unique, args.nicheId);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
