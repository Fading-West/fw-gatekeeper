/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as alerts from "../alerts.js";
import type * as attendance from "../attendance.js";
import type * as attendanceCorrections from "../attendanceCorrections.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as kioskLookup from "../kioskLookup.js";
import type * as kiosks from "../kiosks.js";
import type * as localDate from "../localDate.js";
import type * as portalMembers from "../portalMembers.js";
import type * as recognitionAttempts from "../recognitionAttempts.js";
import type * as schedules from "../schedules.js";
import type * as seed from "../seed.js";
import type * as shiftBriefing from "../shiftBriefing.js";
import type * as shiftCloseouts from "../shiftCloseouts.js";
import type * as shiftExceptions from "../shiftExceptions.js";
import type * as stats from "../stats.js";
import type * as workers from "../workers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  alerts: typeof alerts;
  attendance: typeof attendance;
  attendanceCorrections: typeof attendanceCorrections;
  auth: typeof auth;
  crons: typeof crons;
  health: typeof health;
  http: typeof http;
  kioskLookup: typeof kioskLookup;
  kiosks: typeof kiosks;
  localDate: typeof localDate;
  portalMembers: typeof portalMembers;
  recognitionAttempts: typeof recognitionAttempts;
  schedules: typeof schedules;
  seed: typeof seed;
  shiftBriefing: typeof shiftBriefing;
  shiftCloseouts: typeof shiftCloseouts;
  shiftExceptions: typeof shiftExceptions;
  stats: typeof stats;
  workers: typeof workers;
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
