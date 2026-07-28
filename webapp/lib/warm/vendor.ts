import "server-only";

/**
 * The warm-intro VENDOR boundary — the one place a request leaves this app for a
 * people-data provider, and the one place that knows the provider's name.
 *
 * WHY THIS IS SERVER-ONLY AND LIVES HERE, NOT IN `lib/referral/`
 *
 * `lib/referral/` is layer 0: every LinkedIn URL there is an `<a href>` a person
 * clicks in their own session, and `tests/unit/referral-hard-line.test.ts` sweeps
 * that whole directory forbidding `fetch`, because a single well-meaning request
 * added there is the account-ending category (the risk ladder in
 * `docs/plans/REFERRAL-FINDER.md`). This file is the OPPOSITE lane — layer 1, a
 * real network call — so it lives outside that directory, carries `server-only` so
 * a client bundle importing it fails the build, and reads the vendor token from a
 * NON-`NEXT_PUBLIC_` env var. The token's containment is proven, not promised, by
 * `tests/unit/service-key-containment.test.ts` (extended to canary `APIFY_TOKEN`).
 *
 * WHY AN INTERFACE (the Proxycurl-death insurance)
 *
 * harvestapi is a scraper, not a licensed DB — the same category as Proxycurl,
 * which was sued and shut down (its marketing domain already redirects to a
 * for-sale page). So NOTHING downstream of `WarmVendor` knows the name harvestapi:
 * the routes, the store, and the UI speak only `WarmQuery`/`RawCandidate`. Swapping
 * the vendor is one new `implements WarmVendor` class. `FakeWarmVendor` is a second
 * implementation used by every test and by demo mode, deterministic and offline.
 *
 * WHY start / poll / cancel AND NOT a single blocking `search()`
 *
 * A Vercel function returns in seconds and a vendor run is start → poll → fetch, so
 * the lifecycle is split to match the async DB row: the start route kicks the runs
 * and returns fast, the poll route advances them, and — the reason it is split at
 * all — `cancel` can abort a run that is still going. A blocking `search()` would
 * hold the function open and give the user nothing to cancel.
 */

import { cookies } from "next/headers";
import { companyNameKey } from "@/lib/data/view-models";
import { fakeCandidatesFor } from "@/lib/data/warm-fixtures";
import { isDemoMode } from "@/lib/data/source";
import { WARM_PER_PERSONA_ITEMS } from "./config";
import type { RawCandidate, WarmParams, WarmPersona } from "./types";

/** One persona's query — vendor-neutral. The adapter maps this to its own facets. */
export type WarmQuery = {
  persona: WarmPersona;
  /** The plain persona string the user saw and could edit. */
  text: string;
  company: string;
  /** The `/company/<slug>` URL when known (see the mapping note); else undefined. */
  companyUrl?: string;
  /** Warm overlays — the user's schools / past employers, when stored. */
  schools?: readonly string[];
  pastCompanies?: readonly string[];
  location?: string;
};

/**
 * One started run, WITH the query that produced it. The query carries the persona
 * (and the overlays), which is the whole point: start and poll are separate HTTP
 * requests and the vendor is rebuilt per request, so the persona cannot live in
 * vendor instance memory — it must ride on the handle, which the DB persists and
 * the poll route reconstructs. Losing this is the M1 bug (every candidate stamped
 * "role", recruiter guarantee dead).
 */
export type WarmRun = { runId: string; query: WarmQuery };

/** The vendor's run handle — one run per persona query, each carrying its query. */
export type WarmRunHandle = { runs: WarmRun[] };

/** A poll's answer: terminal-or-not, plus the merged raw candidates when done. */
export type WarmPoll = {
  status: "running" | "succeeded" | "failed";
  candidates: RawCandidate[];
  error?: string;
};

export interface WarmVendor {
  /** Kick off every persona query. Returns fast with a persona-carrying handle. */
  start(queries: readonly WarmQuery[], signal?: AbortSignal): Promise<WarmRunHandle>;
  /**
   * Check progress; return merged raw candidates once every run is terminal. Each
   * candidate is stamped with ITS run's persona/overlays FROM `handle.runs[i].query`
   * — never inferred, never from instance memory.
   */
  poll(handle: WarmRunHandle, signal?: AbortSignal): Promise<WarmPoll>;
  /** Abort every still-running query. Idempotent; a terminal run is a no-op. */
  cancel(handle: WarmRunHandle, signal?: AbortSignal): Promise<void>;
}

type WarmTarget = {
  company: string;
  companyUrl?: string;
  schools?: readonly string[];
  pastCompanies?: readonly string[];
  location?: string;
};

/**
 * One persona's query for a target. Pure and vendor-neutral. `text` is the plain
 * persona string used at START; the poll route rebuilds queries with `text: ""`
 * because poll only STAMPS results (persona + overlays), it does not re-search.
 */
export function queryForPersona(persona: WarmPersona, text: string, target: WarmTarget): WarmQuery {
  return {
    persona,
    text,
    company: target.company,
    companyUrl: target.companyUrl,
    schools: target.schools,
    pastCompanies: target.pastCompanies,
    location: target.location,
  };
}

/** The three persona queries for a target, from the editable persona strings. */
export function buildWarmQueries(params: WarmParams, target: WarmTarget): WarmQuery[] {
  return [
    queryForPersona("role", params.role, target),
    queryForPersona("senior", params.senior, target),
    queryForPersona("recruiter", params.recruiter, target),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// harvestapi (Apify) — the real adapter
// ════════════════════════════════════════════════════════════════════════════

const APIFY_BASE = "https://api.apify.com/v2";
const HARVEST_ACTOR = "harvestapi~linkedin-profile-search";

/** The seniority facet ids harvestapi uses for "Director/VP and above". */
const SENIOR_SENIORITY_IDS = ["220", "300", "310"]; // Director, VP, CXO

/**
 * The harvestapi input for one persona query — Short mode, one page (≤25).
 *
 * Pure, exported for the unit test: the mapping from three plain strings to
 * harvestapi facets is the load-bearing part and it is proven without spending a
 * cent (the brief bills every page at $0.10). The company is expressed BOTH as a
 * `/company/<slug>` URL when one is known AND in `searchQuery`, because we store
 * the numeric id, not the slug (see the poke-list) — the `searchQuery` company
 * name is the honest fallback that lands without a slug.
 */
export function buildProfileSearchInput(query: WarmQuery): Record<string, unknown> {
  const input: Record<string, unknown> = {
    profileScraperMode: "Short",
    maxItems: WARM_PER_PERSONA_ITEMS,
    takePages: 1,
  };

  if (query.companyUrl) input.currentCompanies = [query.companyUrl];

  const terms: string[] = [];
  if (query.persona === "recruiter") {
    input.currentJobTitles = [query.text, "Recruiter", "Talent Acquisition", "Technical Sourcer"];
  } else {
    input.currentJobTitles = [query.text];
    if (query.persona === "senior") input.seniorityLevelIds = SENIOR_SENIORITY_IDS;
  }
  // The company name, quoted, so a search with no slug still lands on the company.
  if (query.company) terms.push(`"${query.company}"`);
  if (terms.length) input.searchQuery = terms.join(" ");

  if (query.schools && query.schools.length) input.schools = [...query.schools];
  if (query.pastCompanies && query.pastCompanies.length) {
    input.pastCompanies = [...query.pastCompanies];
  }
  if (query.location) input.locations = [query.location];

  return input;
}

/**
 * One harvestapi dataset record → a `RawCandidate`. Pure, exported for the unit
 * test. Every field read defensively: this crosses a JSON boundary the compiler
 * cannot see into, and a renamed vendor field must arrive as "" rather than the
 * word "undefined" next to somebody's name. `matchedSchool`/`matchedPastCompany`
 * are stamped from the query's OWN overlay facets, because a Short-mode record
 * does not carry education — the row matched the facet by construction.
 */
export function mapDatasetItem(item: unknown, query: WarmQuery): RawCandidate {
  const o = (item ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const first = str(o.firstName);
  const last = str(o.lastName);
  const fullName = str(o.name) || [first, last].filter(Boolean).join(" ");

  const pos = Array.isArray(o.currentPosition) ? (o.currentPosition[0] as Record<string, unknown>) : undefined;
  const headline = str(o.headline) || (pos ? str(pos.position) : "");
  const company = (pos ? str(pos.companyName) : "") || query.company;

  // The live actor emits `location.linkedinText` (a string) and
  // `location.parsed.{text,city,country}` — NOT a top-level `location.text`, and
  // `location.parsed` is an OBJECT (m2). Read the string forms, deepest-first.
  const loc = o.location as Record<string, unknown> | string | undefined;
  const parsed = (loc && typeof loc === "object" ? loc.parsed : undefined) as
    | Record<string, unknown>
    | undefined;
  const location =
    typeof loc === "string"
      ? loc
      : str(loc?.linkedinText) || str(parsed?.text) || str(loc?.text);

  return {
    persona: query.persona,
    fullName,
    headline,
    company,
    location,
    years: "",
    linkedinUrl: str(o.linkedinUrl) || str(o.publicIdentifier),
    // Stamped from the query's OWN overlay facets, not from the record: a Short-mode
    // profile carries no education, but a row returned by an INCLUDE-filtered query
    // matched that facet BY CONSTRUCTION. This is what fires the school/past-company
    // rank weights on the real path.
    matchedSchool: query.schools && query.schools.length ? query.schools[0] : undefined,
    matchedPastCompany:
      query.pastCompanies && query.pastCompanies.length ? query.pastCompanies[0] : undefined,
  };
}

/** The vendor token, read in exactly this file. Never `NEXT_PUBLIC_`. */
function apifyToken(): string | null {
  return process.env.APIFY_TOKEN || null;
}

export function warmVendorConfigured(): boolean {
  return apifyToken() !== null;
}

export class HarvestApiVendor implements WarmVendor {
  private readonly token: string;

  constructor(token?: string) {
    const t = token ?? apifyToken();
    if (!t) {
      throw new Error("APIFY_TOKEN missing — the warm-intro finder cannot start a vendor run.");
    }
    this.token = t;
  }

  async start(queries: readonly WarmQuery[], signal?: AbortSignal): Promise<WarmRunHandle> {
    const runs: WarmRun[] = [];
    try {
      for (const query of queries) {
        const res = await fetch(`${APIFY_BASE}/acts/${HARVEST_ACTOR}/runs?token=${this.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildProfileSearchInput(query)),
          signal,
        });
        if (!res.ok) throw new Error(`vendor start failed (${res.status})`);
        const body = (await res.json()) as { data?: { id?: string } };
        const id = body.data?.id;
        if (!id) throw new Error("vendor start returned no run id");
        runs.push({ runId: id, query });
      }
    } catch (err) {
      // m1: a partial start already BILLED the runs it did start. Abort them before
      // rethrowing, or they run to completion on Apify, charged, with no row that
      // could ever cancel them (their ids were never returned).
      await this.abort(runs.map((r) => r.runId)).catch(() => undefined);
      throw err;
    }
    return { runs };
  }

  async poll(handle: WarmRunHandle, signal?: AbortSignal): Promise<WarmPoll> {
    const candidates: RawCandidate[] = [];
    for (const run of handle.runs) {
      const res = await fetch(`${APIFY_BASE}/actor-runs/${run.runId}?token=${this.token}`, {
        signal,
      });
      if (!res.ok) throw new Error(`vendor poll failed (${res.status})`);
      const body = (await res.json()) as {
        data?: { status?: string; defaultDatasetId?: string };
      };
      const status = body.data?.status ?? "";
      // Any run still going means the whole request is still going: the merge needs
      // every persona before it can rank, and a partial rank would drop people the
      // slower query is about to return.
      if (status === "READY" || status === "RUNNING") {
        return { status: "running", candidates: [] };
      }
      if (status !== "SUCCEEDED") {
        return { status: "failed", candidates: [], error: `run ${run.runId} ${status || "unknown"}` };
      }
      const datasetId = body.data?.defaultDatasetId;
      if (!datasetId) continue;
      const items = await this.fetchDataset(datasetId, signal);
      // The persona (and overlays) come from `run.query`, reconstructed from the
      // persisted row by the poll route — NOT from instance memory. This is the M1
      // fix: every candidate is attributed to the persona that actually found it.
      for (const item of items.slice(0, WARM_PER_PERSONA_ITEMS)) {
        candidates.push(mapDatasetItem(item, run.query));
      }
    }
    return { status: "succeeded", candidates };
  }

  async cancel(handle: WarmRunHandle, signal?: AbortSignal): Promise<void> {
    await this.abort(handle.runs.map((r) => r.runId), signal);
  }

  /** Best-effort, idempotent abort of run ids (aborting a finished run is a swallowed 4xx). */
  private async abort(runIds: readonly string[], signal?: AbortSignal): Promise<void> {
    await Promise.all(
      runIds.map((runId) =>
        fetch(`${APIFY_BASE}/actor-runs/${runId}/abort?token=${this.token}`, {
          method: "POST",
          signal,
        }).catch(() => undefined),
      ),
    );
  }

  private async fetchDataset(datasetId: string, signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(
      `${APIFY_BASE}/datasets/${datasetId}/items?token=${this.token}&clean=true&limit=${WARM_PER_PERSONA_ITEMS}`,
      { signal },
    );
    if (!res.ok) throw new Error(`vendor dataset fetch failed (${res.status})`);
    const items = (await res.json()) as unknown;
    return Array.isArray(items) ? items : [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// the fake — deterministic, offline, every test and demo mode
// ════════════════════════════════════════════════════════════════════════════

export type FakeWarmMode = "results" | "pending" | "empty" | "fail";

/**
 * Deterministic vendor for tests and demo mode. Its output matches `RawCandidate`
 * exactly (via `fakeCandidatesFor`), and its lifecycle is a MODE not a clock, so
 * every UI state is reachable without a flake (results / pending / empty / fail).
 *
 * PARITY WITH THE REAL PATH, by construction: `poll` attributes each candidate to
 * `run.query.persona` — the SAME source the real adapter uses, reconstructed from
 * the persisted row by the poll route. The fake CANNOT be more forgiving about
 * persona than production, which is the exact "fake more capable than the real API"
 * failure the M1 bug was. Each run contributes only its own persona's fixtures, as
 * a real per-persona dataset would. `warm-vendor.test.ts` pins the parity.
 */
export class FakeWarmVendor implements WarmVendor {
  constructor(private readonly mode: FakeWarmMode = "results") {}

  async start(queries: readonly WarmQuery[]): Promise<WarmRunHandle> {
    const company = queries[0]?.company ?? "";
    return {
      runs: queries.map((query) => ({
        runId: `fake:${encodeURIComponent(company)}:${query.persona}`,
        query,
      })),
    };
  }

  async poll(handle: WarmRunHandle): Promise<WarmPoll> {
    if (this.mode === "pending") return { status: "running", candidates: [] };
    if (this.mode === "fail") {
      return { status: "failed", candidates: [], error: "the vendor could not be reached" };
    }
    if (this.mode === "empty") return { status: "succeeded", candidates: [] };
    const candidates: RawCandidate[] = [];
    for (const run of handle.runs) {
      const company = run.query.company;
      const forPersona = fakeCandidatesFor(company, companyNameKey(company)).filter(
        (c) => c.persona === run.query.persona,
      );
      candidates.push(...forPersona);
    }
    return { status: "succeeded", candidates };
  }

  async cancel(): Promise<void> {
    /* nothing to abort in the fake */
  }
}

// ════════════════════════════════════════════════════════════════════════════
// selection — Fake in demo (mode from a cookie the E2E sets), harvestapi in real
// ════════════════════════════════════════════════════════════════════════════

const WARM_MODE_COOKIE = "hq_warm_mode";

/**
 * The vendor a route uses when it does not inject one (unit tests inject a fake).
 *
 * Demo mode returns the `FakeWarmVendor`, its MODE read from a cookie so an E2E can
 * drive the server into the running / empty / failed states — the same channel
 * `hq_demo_seed` and `hq_demo_fail` use, and gated by `isDemoMode()` for the same
 * reason: a deployment that fell back to fixtures for a missing env var must not let
 * a visitor steer the vendor.
 */
export async function getWarmVendor(): Promise<WarmVendor> {
  if (isDemoMode()) {
    let mode: FakeWarmMode = "results";
    try {
      const value = (await cookies()).get(WARM_MODE_COOKIE)?.value;
      if (value === "pending" || value === "empty" || value === "fail" || value === "results") {
        mode = value;
      }
    } catch {
      /* cookies() unavailable in some contexts; the default mode is fine */
    }
    return new FakeWarmVendor(mode);
  }
  return new HarvestApiVendor();
}
