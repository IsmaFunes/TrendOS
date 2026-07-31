import { cronJobs } from "convex/server";

const crons = cronJobs();

// Meta Ad Library scrape is driven by the external worker + enqueue from onboarding.
// No paid Gemini/SerpAPI crons in the MVP path.

export default crons;
