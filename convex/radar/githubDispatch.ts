/**
 * Best-effort ping to GitHub Actions to run the Meta Ad scrape workflow
 * immediately, instead of waiting for its 15-minute schedule
 * (.github/workflows/scrape-meta-ads.yml) — Convex can't run Playwright
 * itself, so this is how a brand-new niche's queued job gets claimed within
 * seconds rather than up to 15 minutes. Never throws: the scheduled poll is
 * the reliable fallback if GITHUB_ACTIONS_TOKEN isn't configured or the API
 * call fails, so a dispatch failure should never break niche creation.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { structuredLog } from "./http";

const GITHUB_REPO = "IsmaFunes/TrendOS";
const WORKFLOW_FILE = "scrape-meta-ads.yml";
const GITHUB_REF = "main";

export const dispatchScrapeWorkflow = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    const token = process.env.GITHUB_ACTIONS_TOKEN?.trim();
    if (!token) return null;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: GITHUB_REF }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        structuredLog({
          source: "github_dispatch",
          errorType: `http_${res.status}`,
          message: body.slice(0, 300),
          level: "warn",
        });
      }
    } catch (err) {
      structuredLog({
        source: "github_dispatch",
        errorType: "fetch_failed",
        message: err instanceof Error ? err.message : String(err),
        level: "warn",
      });
    }
    return null;
  },
});
