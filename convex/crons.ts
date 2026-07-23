import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Default free-plan cadence: every 8 hours. PRO faster refresh is prepared via
// users.refreshIntervalHours but MVP uses a single global cron.
crons.interval(
  "ingest active niches MLA",
  { hours: 8 },
  internal.ingestion.runActiveNiches,
  { siteId: "MLA" },
);

export default crons;
