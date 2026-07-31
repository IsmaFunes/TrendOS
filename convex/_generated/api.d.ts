/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_wipeAll from "../admin/wipeAll.js";
import type * as categories from "../categories.js";
import type * as crons from "../crons.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_nicheProfile from "../lib/nicheProfile.js";
import type * as radar_adRanking from "../radar/adRanking.js";
import type * as radar_adRelevance from "../radar/adRelevance.js";
import type * as radar_backtest from "../radar/backtest.js";
import type * as radar_contracts from "../radar/contracts.js";
import type * as radar_discovery from "../radar/discovery.js";
import type * as radar_features from "../radar/features.js";
import type * as radar_geminiAds from "../radar/geminiAds.js";
import type * as radar_geminiAdsCore from "../radar/geminiAdsCore.js";
import type * as radar_http from "../radar/http.js";
import type * as radar_imports from "../radar/imports.js";
import type * as radar_jobs from "../radar/jobs.js";
import type * as radar_logistics from "../radar/logistics.js";
import type * as radar_matching from "../radar/matching.js";
import type * as radar_metaAds from "../radar/metaAds.js";
import type * as radar_metrics from "../radar/metrics.js";
import type * as radar_niches from "../radar/niches.js";
import type * as radar_normalize from "../radar/normalize.js";
import type * as radar_productEvidence from "../radar/productEvidence.js";
import type * as radar_products from "../radar/products.js";
import type * as radar_providers_aliexpress from "../radar/providers/aliexpress.js";
import type * as radar_providers_chinaB2b from "../radar/providers/chinaB2b.js";
import type * as radar_providers_geminiResearch from "../radar/providers/geminiResearch.js";
import type * as radar_providers_googleTrends from "../radar/providers/googleTrends.js";
import type * as radar_providers_manualSocial from "../radar/providers/manualSocial.js";
import type * as radar_providers_mercadolibre from "../radar/providers/mercadolibre.js";
import type * as radar_providers_mlAuth from "../radar/providers/mlAuth.js";
import type * as radar_providers_registry from "../radar/providers/registry.js";
import type * as radar_providers_wholesale from "../radar/providers/wholesale.js";
import type * as radar_review from "../radar/review.js";
import type * as radar_scoring from "../radar/scoring.js";
import type * as radar_seasonality from "../radar/seasonality.js";
import type * as radar_seed from "../radar/seed.js";
import type * as radar_validators from "../radar/validators.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/wipeAll": typeof admin_wipeAll;
  categories: typeof categories;
  crons: typeof crons;
  "lib/auth": typeof lib_auth;
  "lib/nicheProfile": typeof lib_nicheProfile;
  "radar/adRanking": typeof radar_adRanking;
  "radar/adRelevance": typeof radar_adRelevance;
  "radar/backtest": typeof radar_backtest;
  "radar/contracts": typeof radar_contracts;
  "radar/discovery": typeof radar_discovery;
  "radar/features": typeof radar_features;
  "radar/geminiAds": typeof radar_geminiAds;
  "radar/geminiAdsCore": typeof radar_geminiAdsCore;
  "radar/http": typeof radar_http;
  "radar/imports": typeof radar_imports;
  "radar/jobs": typeof radar_jobs;
  "radar/logistics": typeof radar_logistics;
  "radar/matching": typeof radar_matching;
  "radar/metaAds": typeof radar_metaAds;
  "radar/metrics": typeof radar_metrics;
  "radar/niches": typeof radar_niches;
  "radar/normalize": typeof radar_normalize;
  "radar/productEvidence": typeof radar_productEvidence;
  "radar/products": typeof radar_products;
  "radar/providers/aliexpress": typeof radar_providers_aliexpress;
  "radar/providers/chinaB2b": typeof radar_providers_chinaB2b;
  "radar/providers/geminiResearch": typeof radar_providers_geminiResearch;
  "radar/providers/googleTrends": typeof radar_providers_googleTrends;
  "radar/providers/manualSocial": typeof radar_providers_manualSocial;
  "radar/providers/mercadolibre": typeof radar_providers_mercadolibre;
  "radar/providers/mlAuth": typeof radar_providers_mlAuth;
  "radar/providers/registry": typeof radar_providers_registry;
  "radar/providers/wholesale": typeof radar_providers_wholesale;
  "radar/review": typeof radar_review;
  "radar/scoring": typeof radar_scoring;
  "radar/seasonality": typeof radar_seasonality;
  "radar/seed": typeof radar_seed;
  "radar/validators": typeof radar_validators;
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
