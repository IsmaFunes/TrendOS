import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Meta Ad Library scrape is driven by the external worker + enqueue from onboarding.
// This sweep re-queues niches stuck below MIN_ADS_READY that no new user has
// attached to since their last (under-filled) scrape.
crons.interval(
  "sweep underfilled niches",
  { hours: 6 },
  internal.radar.niches.sweepUnderfilledNiches,
  {},
);

// Keeps already-"ready" niches from going stale indefinitely — pairs with
// the GitHub Actions scheduled workflow (.github/workflows/scrape-meta-ads.yml)
// that actually runs the Playwright worker to claim the jobs this queues.
crons.interval(
  "refresh all ready niches",
  { hours: 24 },
  internal.radar.niches.refreshAllReadyNiches,
  {},
);

export default crons;
