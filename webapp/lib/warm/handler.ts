import "server-only";

import { NextResponse } from "next/server";
import { getDataSource } from "@/lib/data/get-source";
import type { DataSource, WarmOverlays, WarmSearchView } from "@/lib/data/source";
import { declaresOverCap, readBoundedBody } from "@/lib/http/bounded";
import { WARM_MAX_START_BYTES } from "./config";
import { analyzeFit } from "./fit";
import { normalizeWarmParams, rankCandidates, sortByFit, type WarmParams } from "./types";
import {
  buildWarmQueries,
  getWarmVendor,
  queryForPersona,
  type WarmRunHandle,
  type WarmVendor,
} from "./vendor";

/**
 * The warm-intro finder's orchestration — the three routes' logic, here rather
 * than in `route.ts` for `handleCapture`'s reason (Next validates a route module's
 * exports against a closed set, so a helper export there is a build failure) AND so
 * the unit suite can drive the real logic with a fake vendor + fixture store.
 *
 * THE LIFECYCLE, which is what makes the async row + the Cancel real:
 *
 *   start   creates the row (cap-enforced), THEN starts the vendor run and attaches
 *           the handle — the row is the reservation, so a vendor that throws leaves
 *           a failed row the user can see, not a charge with nothing behind it.
 *   poll    reads the row; if it is still running, advances the vendor run and, on
 *           success, RANKS and lands the results in one transition. Each poll is a
 *           short function (one Apify round trip), which is what keeps it
 *           Vercel-safe — there is no long-held connection anywhere.
 *   cancel  aborts the vendor run AND flips the row, idempotently.
 *
 * `runIds` never reaches the browser: `toClient` strips it, so nothing about the
 * vendor leaks past this app (the WarmVendor-abstraction rule).
 */

export type WarmDeps = { source: DataSource; vendor: WarmVendor };

async function resolveDeps(deps?: Partial<WarmDeps>): Promise<WarmDeps> {
  return {
    source: deps?.source ?? (await getDataSource()),
    vendor: deps?.vendor ?? (await getWarmVendor()),
  };
}

/** The client shape — the search WITHOUT the persisted vendor runs. */
function toClient(search: WarmSearchView) {
  const { runs: _runs, ...rest } = search;
  return rest;
}

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Rebuild the vendor handle from the PERSISTED row — the persona per run
 * (`search.runs`) + the overlays + the company. This is the M1 fix in action: the
 * poll route is a fresh request with a fresh vendor, so the persona↔run mapping
 * comes from the database, never from vendor instance memory. `text` is "" because
 * poll only stamps results, it does not re-search.
 */
function reconstructHandle(search: WarmSearchView): WarmRunHandle {
  const target = {
    company: search.company,
    schools: search.overlays.schools,
    pastCompanies: search.overlays.pastCompanies,
  };
  return {
    runs: search.runs.map((r) => ({ runId: r.runId, query: queryForPersona(r.persona, "", target) })),
  };
}

// ---------------------------------------------------------------- start

type StartBody = {
  targetKind: "posting" | "company";
  postingKey: string;
  company: string;
  params: WarmParams;
  overlays: WarmOverlays;
  idempotencyKey: string;
};

/** A bounded string array from the wire — up to 5 entries, each ≤120 chars. */
function boundedStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, 120))
    .filter((s) => s !== "")
    .slice(0, 5);
}

function parseStart(body: unknown): { ok: true; value: StartBody } | { ok: false; why: string } {
  if (typeof body !== "object" || body === null) return { ok: false, why: "Malformed request." };
  const o = body as Record<string, unknown>;
  const targetKind = o.targetKind === "company" ? "company" : "posting";
  const company = typeof o.company === "string" ? o.company.trim().slice(0, 200) : "";
  if (company === "") return { ok: false, why: "A company is required." };
  const idempotencyKey = typeof o.idempotencyKey === "string" ? o.idempotencyKey : "";
  if (idempotencyKey.trim() === "" || idempotencyKey.length > 200) {
    return { ok: false, why: "Invalid idempotency key." };
  }
  // `normalizeWarmParams` fills any missing/blank persona from the derived default
  // — the client sends the defaults or the user's per-search edits, and a blank
  // persona must never reach the vendor as an empty query.
  const rawParams = (o.params ?? {}) as Record<string, unknown>;
  const roleForFallback = typeof rawParams.role === "string" ? rawParams.role : "";
  const params = normalizeWarmParams(rawParams, roleForFallback);
  const rawOverlays = (o.overlays ?? {}) as Record<string, unknown>;
  const overlays: WarmOverlays = {
    schools: boundedStrings(rawOverlays.schools),
    pastCompanies: boundedStrings(rawOverlays.pastCompanies),
  };
  const postingKey = typeof o.postingKey === "string" ? o.postingKey.slice(0, 200) : "";
  return { ok: true, value: { targetKind, postingKey, company, params, overlays, idempotencyKey } };
}

export async function handleWarmStart(
  request: Request,
  deps?: Partial<WarmDeps>,
): Promise<NextResponse> {
  if (declaresOverCap(request.headers, WARM_MAX_START_BYTES)) {
    return fail("That request is too large.", 413);
  }
  const read = await readBoundedBody(request, WARM_MAX_START_BYTES);
  if (!read.ok) {
    return read.why === "too-large" ? fail("That request is too large.", 413) : fail("Empty body.", 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text || "null");
  } catch {
    return fail("The body is not JSON.", 400);
  }
  const parsed = parseStart(body);
  if (!parsed.ok) return fail(parsed.why, 400);

  const { source, vendor } = await resolveDeps(deps);
  const started = await source.startWarmSearch(parsed.value);
  if (!started.ok) {
    if (started.kind === "auth") return fail("Your session expired — sign in again.", 401);
    if (started.kind === "over-cap") return NextResponse.json({ error: started.message }, { status: 429 });
    return fail(started.message, 400);
  }

  let search = started.search;
  // Start the vendor run. A throw here leaves a row already charged, so it is
  // recorded as FAILED rather than swallowed — the user sees a failed search, which
  // is the truth, instead of a spinner that never resolves.
  try {
    const queries = buildWarmQueries(search.params, {
      company: search.company,
      schools: search.overlays.schools,
      pastCompanies: search.overlays.pastCompanies,
    });
    const handle = await vendor.start(queries);
    // Persist the PERSONA per run — the whole point of `vendor_runs` (M1).
    const runs = handle.runs.map((r) => ({ runId: r.runId, persona: r.query.persona }));
    const attached = await source.attachWarmRun({ id: search.id, runs });
    if (attached.ok) search = attached.search;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "the vendor could not be reached";
    const failed = await source.failWarmSearch({ id: search.id, error: reason });
    if (failed.ok) search = failed.search;
  }

  return NextResponse.json(toClient(search));
}

// ---------------------------------------------------------------- poll

export async function handleWarmPoll(id: string, deps?: Partial<WarmDeps>): Promise<NextResponse> {
  const { source, vendor } = await resolveDeps(deps);
  let search = await source.getWarmSearch(id);
  if (!search) return fail("No such search.", 404);

  if (search.status === "running" && search.runs.length > 0) {
    try {
      const poll = await vendor.poll(reconstructHandle(search));
      if (poll.status === "succeeded") {
        // Rank HERE, app-side, from the vendor's raw candidates (persona-attributed
        // by the reconstructed handle) — the vendor never ranks, so a swap keeps the
        // same transparent model. Then annotate fit (fail-safe) and re-order by it.
        const ranked = rankCandidates(poll.candidates);
        const fitted = sortByFit(
          await analyzeFit(ranked, {
            role: search.params.role,
            company: search.company,
            schools: search.overlays.schools,
            pastCompanies: search.overlays.pastCompanies,
          }),
        );
        const done = await source.completeWarmSearch({ id, results: fitted });
        if (done.ok) search = done.search;
      } else if (poll.status === "failed") {
        const failed = await source.failWarmSearch({ id, error: poll.error ?? "the vendor failed" });
        if (failed.ok) search = failed.search;
      }
      // 'running' → leave the row as it is; the client polls again.
    } catch {
      // A transient poll error is not a failed search — the next poll retries, and
      // the Cancel button is there if the user gives up. Return the running row.
    }
  }

  return NextResponse.json(toClient(search));
}

// ---------------------------------------------------------------- cancel

export async function handleWarmCancel(
  id: string,
  deps?: Partial<WarmDeps>,
): Promise<NextResponse> {
  const { source, vendor } = await resolveDeps(deps);
  const search = await source.getWarmSearch(id);
  if (!search) return fail("No such search.", 404);

  // Abort the vendor run FIRST (best-effort, idempotent — aborting a finished run is
  // a swallowed 4xx), then flip the row. A cancel of an already-terminal search is a
  // no-op that returns the current status, never an error.
  if (search.runs.length > 0) {
    try {
      await vendor.cancel(reconstructHandle(search));
    } catch {
      /* the row flip below is what the user observes */
    }
  }
  const cancelled = await source.cancelWarmSearch(id);
  if (!cancelled.ok) {
    if (cancelled.kind === "missing") return fail("No such search.", 404);
    if (cancelled.kind === "auth") return fail("Your session expired — sign in again.", 401);
    return fail(cancelled.message, 400);
  }
  return NextResponse.json(toClient(cancelled.search));
}
