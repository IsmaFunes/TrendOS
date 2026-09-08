import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Fixed niche catalog: one scrape job per (active niche, country) pair,
// every 24h. The GitHub Actions scheduled workflow
// (.github/workflows/scrape-meta-ads.yml, polling every 15 min) is what
// actually runs the Playwright worker that claims and completes these jobs.
crons.interval(
  "enqueue daily niche scrape jobs",
  { hours: 24 },
  internal.radar.niches.enqueueDailyScrapeJobs,
  {},
);

export default crons;
