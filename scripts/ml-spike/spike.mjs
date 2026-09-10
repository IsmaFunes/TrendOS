/**
 * One-off spike: does a stealth-Playwright browser clear MercadoLibre
 * Argentina's bot-gate from wherever this runs?
 *
 * Manual testing (plain `fetch`, browser UA, warmed-up session cookies —
 * see the investigate.ts / geminiResearch.ts comments) all hit the same
 * wall: any request to a search-listing or item-permalink URL gets a 302
 * to /gz/account-verification, with an `x-is-search-bot: true` response
 * header — on the FIRST request, before any behavioral pattern could be
 * established. That points at an IP/ASN reputation check, which a
 * stealth-JS-fingerprint plugin can't fix (it doesn't change the egress
 * IP). This script actually tries it with a real headless browser from
 * wherever the workflow runs (a GitHub Actions runner, i.e. a different IP
 * range than whatever ran the manual curl checks) instead of assuming.
 *
 * Not wired into the real scrape pipeline — this is disposable, throwaway
 * code to answer one question. Delete this directory once the question is
 * answered either way.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const SEARCH_URL = "https://listado.mercadolibre.com.ar/termo";
const ITEM_URL = "https://articulo.mercadolibre.com.ar/MLA-921234567-termo-acero-1l-_JM";
const NAV_TIMEOUT_MS = 20_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function isGated(finalUrl) {
  return finalUrl.includes("account-verification") || finalUrl.includes("/gz/");
}

async function checkUrl(page, label, url) {
  let finalUrl = null;
  let status = null;
  let title = null;
  let hasListingContent = false;
  let error = null;
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    status = response ? response.status() : null;
    finalUrl = page.url();
    title = await page.title();
    // Real search-results / item pages have this marker somewhere in the
    // DOM; the account-verification challenge page doesn't.
    hasListingContent = await page
      .locator(".ui-search-result, .ui-pdp-title, [class*='ui-search']")
      .first()
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const gated = finalUrl ? isGated(finalUrl) : null;
  console.log(
    JSON.stringify(
      { label, requestedUrl: url, finalUrl, status, title, hasListingContent, gated, error },
      null,
      2,
    ),
  );
  return { label, gated, hasListingContent, error };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "es-AR",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "es-AR,es;q=0.9" },
  });
  const page = await context.newPage();

  console.log("=== Step 1: homepage (warm up session/cookies) ===");
  await checkUrl(page, "homepage", "https://www.mercadolibre.com.ar/");

  console.log("\n=== Step 2: search listing ===");
  const searchResult = await checkUrl(page, "search", SEARCH_URL);

  console.log("\n=== Step 3: item permalink ===");
  const itemResult = await checkUrl(page, "item", ITEM_URL);

  await browser.close();

  const results = [searchResult, itemResult];
  const cleared = results.every((r) => r.gated === false && r.hasListingContent);
  const stillGated = results.some((r) => r.gated === true);

  console.log("\n=== VERDICT ===");
  if (cleared) {
    console.log(
      "CLEARED: both search and item pages resolved to real content, no account-verification redirect. Playwright+stealth from this runner beats the gate — the niche-cache ML scraper plan is viable as designed.",
    );
  } else if (stillGated) {
    console.log(
      "STILL GATED: at least one request was redirected to account-verification even with a real stealth browser. This confirms the gate is IP/network-level, not just missing browser fingerprint signals — a plain worker on this infrastructure won't get real ML data no matter how good the stealth layer is. Would need a residential/rotating-proxy egress to revisit this.",
    );
  } else {
    console.log(
      "INCONCLUSIVE: no explicit redirect, but expected listing content wasn't found either — page structure may differ from what this script expects (update the CSS selectors), or a network/timeout error occurred. Check the raw JSON above.",
    );
  }

  process.exitCode = cleared ? 0 : 1;
}

main().catch((err) => {
  console.error("Spike script crashed:", err);
  process.exitCode = 1;
});
