import { NextResponse } from "next/server";
import { getDataSource, isConfigured } from "@/lib/data/get-source";
import { PROPOSE_SOURCE_TAGS } from "@/lib/data/view-models";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { MAX_NAME_LENGTH, MAX_PASTE_NAMES, parsePastedNames } from "@/app/(app)/companies/paste";

/**
 * POST /api/companies/propose — the discovery intake contract.
 *
 * WHY A ROUTE AS WELL AS A SERVER ACTION
 *
 * The add form calls `proposeCompaniesAction` directly; it does not need this. This
 * route exists for the caller that is NOT a browser: the discovery agent
 * (`monitor/discovery_agent.py`, P6) proposes companies into a user's universe, and
 * a server action is not addressable from Python. Defining the contract now, against
 * the write path that already works, is what makes wiring the agent later a new
 * BRANCH rather than a new design.
 *
 * THE CONTRACT
 *
 *   { names: string[] }        → proposals, exactly what the paste box sends
 *   { facet: string }          → 501, with the reason. Reserved, not implemented.
 *   { source?: string }        → provenance tag; defaults to "api"
 *   { idempotencyKey?: string } → replay guard; generated when absent
 *
 * Response: `{ proposed: CompanyView[], added: number }`.
 *
 * `facet` answers 501 rather than 400, and that distinction is the point. 400 means
 * "you asked wrong"; 501 means "you asked right and this end has not been built" —
 * which is the true state of the NL path, and the difference between a caller
 * retrying with different input and a caller knowing to wait. It carries the reason
 * in the body so an operator reading a log learns it without reading this file.
 *
 * WHAT IT DOES NOT DO: resolve a board. Rows are written at tier 3 / `manual` by
 * `app_propose_companies`, because nothing reachable from this process probes an ATS.
 * A route that accepted an `ats`/`slug`/`tier` from its caller would let any client
 * assert a reliability tier — a fabricated day-of promise, which is the one class of
 * claim this whole feature is careful not to make.
 *
 * A name that IS already grounded binds to that row rather than to a new one, so
 * posting "Ramp" when the resolver has ashby/ramp subscribes the caller to the real
 * board. The reverse now holds too: when the resolver grounds a name that was pasted
 * first, `reconcile_grounded_company` (migration 0009) upgrades THAT row in place
 * rather than writing a second one, so the subscription this route created survives
 * untouched — there is nothing to repoint. Driven from `monitor.discover_universe`,
 * which owns resolution; this route still writes tier 3 / `manual`, because nothing
 * reachable from this process has probed anything.
 *
 * ONE CASE STILL STALLS, and the on-screen copy says so: if the board the resolver
 * grounds to is already held by a DIFFERENT row — a second spelling, "Aon PLC" beside
 * "Aon" — then merging is a subscription repoint, which 0009 refuses. The pasted row
 * stays tier 3 indefinitely. 0009 writes a `company.grounding_blocked` event to every
 * subscriber so it is visible in the activity trail; surfacing it ON the row in this
 * grid is UI work nobody has done, so do not describe it as a badge.
 */

/** Every external boundary gets a bound (the runbook's first rule). */
const MAX_BODY_BYTES = 256 * 1024;

type Payload = {
  names?: unknown;
  facet?: unknown;
  source?: unknown;
  idempotencyKey?: unknown;
};

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  // An unconfigured deployment must look broken rather than answer 200 with
  // invented behaviour (get-source.ts's NotConfiguredError, same rule).
  if (!isConfigured()) return bad("This deployment is not configured.", 503);

  // Auth is answered HERE rather than left to middleware: middleware redirecting a
  // POST sends `fetch` to `POST /login`, which 405s — matrix row 37, on a new route.
  if (getSupabaseEnv()) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    if (!data?.claims) return bad("Not signed in.", 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return bad("Request body too large.", 413);

  let body: Payload;
  try {
    body = JSON.parse(raw || "{}") as Payload;
  } catch {
    return bad("Body must be JSON.");
  }
  if (typeof body !== "object" || body === null) return bad("Body must be a JSON object.");

  // Reserved, and honest about it. See the header comment for why 501, not 400.
  if (body.facet !== undefined) {
    return NextResponse.json(
      {
        error: "Facet-based discovery is not implemented here.",
        reason:
          "Interpreting a facet into company names is the discovery agent's job " +
          "(monitor/discovery_agent.py). It runs on the Lambda schedule, not in this " +
          "process, and has no route into this endpoint yet. Send `names` instead.",
      },
      { status: 501 },
    );
  }

  // Accepts either a real array or one pasted blob, because the two callers differ:
  // the agent emits a list, a script or a curl pastes text. Both go through the SAME
  // parser the form previews, so no caller gets a different splitting rule.
  let names: string[];
  if (typeof body.names === "string") {
    names = parsePastedNames(body.names);
  } else if (Array.isArray(body.names)) {
    for (const n of body.names) {
      if (typeof n !== "string") return bad("`names` must be strings.");
    }
    names = parsePastedNames((body.names as string[]).join("\n"));
  } else {
    return bad("`names` is required: an array of company names, or one pasted blob.");
  }

  if (names.length === 0) return bad("No usable company names in that request.");
  if (names.length > MAX_PASTE_NAMES) {
    return bad(
      `That is ${names.length} names; the limit is ${MAX_PASTE_NAMES} per request.`,
      413,
    );
  }

  // Closed vocabulary, 0008's ALLOWED_SOURCES. `source` is a reporting dimension
  // the coverage meter groups by, and this route takes calls from outside the
  // browser — an unbounded tag writes a novel into a group-by.
  const source =
    typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 40).toLowerCase()
      : "api";
  if (!(PROPOSE_SOURCE_TAGS as readonly string[]).includes(source)) {
    return bad(`Unknown \`source\` tag: ${source}. One of: ${PROPOSE_SOURCE_TAGS.join(", ")}.`);
  }
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? body.idempotencyKey.slice(0, 200)
      : crypto.randomUUID();

  const src = await getDataSource();
  const result = await src.proposeCompanies({ names, source, idempotencyKey });
  if (!result.ok) {
    return bad(
      result.kind === "auth" ? "Not signed in." : result.message,
      result.kind === "auth" ? 401 : 400,
    );
  }

  return NextResponse.json({
    proposed: result.companies,
    added: result.added,
    // Echoed so a caller can replay the exact same request safely without having to
    // have generated the key itself.
    idempotencyKey,
  });
}

/** Stated so a GET gets an explanation rather than Next's bare 405. */
export async function GET() {
  return NextResponse.json(
    {
      error: "Use POST.",
      contract: {
        POST: { names: "string[] | string", source: "string?", idempotencyKey: "string?" },
        returns: { proposed: "CompanyView[]", added: "number" },
        notes: `Proposals are written at reliability_tier 3 / resolution_method "manual". Nothing here resolves a board. Max ${MAX_PASTE_NAMES} names, ${MAX_NAME_LENGTH} chars each.`,
      },
    },
    { status: 405 },
  );
}
