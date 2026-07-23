/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as categories from "../categories.js";
import type * as crons from "../crons.js";
import type * as gemini from "../gemini.js";
import type * as googleTrends from "../googleTrends.js";
import type * as ingestion from "../ingestion.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_nicheProfile from "../lib/nicheProfile.js";
import type * as limits from "../limits.js";
import type * as ml from "../ml.js";
import type * as productMatch from "../productMatch.js";
import type * as scoring from "../scoring.js";
import type * as trends from "../trends.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  categories: typeof categories;
  crons: typeof crons;
  gemini: typeof gemini;
  googleTrends: typeof googleTrends;
  ingestion: typeof ingestion;
  "lib/auth": typeof lib_auth;
  "lib/nicheProfile": typeof lib_nicheProfile;
  limits: typeof limits;
  ml: typeof ml;
  productMatch: typeof productMatch;
  scoring: typeof scoring;
  trends: typeof trends;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
