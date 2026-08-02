/**
 * The entitlement model, app side (migration 0027).
 *
 * The owner's launch is invite-only, and the shape he asked for is not "refuse
 * strangers at the door" — it is "let anyone create an account, and let nobody
 * use the product until I say so". So there are two gates now: authentication
 * (do you have a session) and entitlement (is your account turned on), and the
 * second one is the new thing.
 *
 * NO `server-only` IN THIS FILE, DELIBERATELY. It is imported by
 * `lib/supabase/middleware.ts`, which Next runs in the edge runtime, and by
 * `lib/data/get-source.ts`, which is server-only itself. Keeping the decision
 * logic free of both runtimes is what lets the SAME predicate run in the route
 * gate and at the data layer — two enforcement points, one rule, so they cannot
 * drift into disagreeing about who is allowed in.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Mirrors the CHECK on `public.entitlements.status`. */
export type EntitlementStatus = "pending" | "active" | "suspended";

export type Entitlement = {
  status: EntitlementStatus;
  /** The owner's "all access but for free" flag. Read by billing, later. */
  invited: boolean;
  /** The billing seam. `'free'` for everybody today; never a gate input. */
  plan: string;
  activatedAt: string | null;
};

/**
 * The select list, one literal, matching the columns 0027 creates.
 *
 * `reason` is NOT here. It is the operator's note about a suspension and the
 * holding surface does not render it: a sentence the owner typed for himself,
 * shown verbatim to the person it is about, is a leak waiting for one blunt
 * word. Selecting it would put it in a payload nobody meant to send.
 */
export const ENTITLEMENT_COLS = "status, invited, plan, activated_at";

/**
 * What an unreadable or absent entitlement means: NOT entitled.
 *
 * Absence is never permission. A user whose row failed to be created, or whose
 * row a future migration forgot, is pending — not active by default. The whole
 * gate is one boolean and this is the direction it falls when it cannot tell.
 */
export const NOT_ENTITLED: Entitlement = {
  status: "pending",
  invited: false,
  plan: "free",
  activatedAt: null,
};

/**
 * Reading one is three outcomes, not two, and collapsing them is a bug.
 *
 * `ok` carries a real answer (including "there is no row", which IS an answer:
 * pending). `unreadable` means the query itself failed — a network blip, a
 * dropped connection, a schema that has not been migrated yet — and the two
 * enforcement points want OPPOSITE things from it:
 *
 *   * the DATA LAYER refuses, because it is the security boundary and a gate
 *     that opens when the store hiccups is a gate anybody can open by making the
 *     store hiccup;
 *   * the ROUTE GATE lets the request through to the data layer, because it is
 *     UX routing and sending every signed-in person to the holding page during a
 *     transient error is an outage the product inflicts on itself.
 *
 * The layout guard above the pages fails open for the same reason its onboarding
 * sibling does; the refusal that matters still happens one layer down.
 */
export type EntitlementRead =
  | { kind: "ok"; entitlement: Entitlement }
  | { kind: "unreadable"; message: string };

function parseStatus(raw: unknown): EntitlementStatus {
  return raw === "active" || raw === "suspended" || raw === "pending" ? raw : "pending";
}

/** One `entitlements` row → the view the gate reads. Unknown status → pending. */
export function parseEntitlement(row: unknown): Entitlement {
  if (!row || typeof row !== "object") return NOT_ENTITLED;
  const r = row as Record<string, unknown>;
  return {
    status: parseStatus(r.status),
    invited: r.invited === true,
    plan: typeof r.plan === "string" && r.plan ? r.plan : "free",
    activatedAt: typeof r.activated_at === "string" ? r.activated_at : null,
  };
}

/** The one predicate. Everything else in this file exists to feed it. */
export function isActive(entitlement: Entitlement): boolean {
  return entitlement.status === "active";
}

/**
 * `SupabaseClient` and not a hand-written structural type, which was the first
 * attempt and is worth recording so nobody re-tries it.
 *
 * A structural `{ from(t): { select(c): { eq(…): { maybeSingle(): … } } } }` reads
 * nicer and lets the unit suite pass a plain object with no cast. It also makes
 * tsc compare its `select(columns: string)` against postgrest-js's
 * `select<Q extends string>(columns?: Q)`, which instantiates the select-list
 * PARSER types with `Q = string` and hits TS2589 ("type instantiation is
 * excessively deep"). The real client is the type this runs against, so the real
 * client is the type it takes; the fake is the thing that gets cast, in the test
 * that owns it — the same trade `supabase-source.ts` makes.
 *
 * The import is type-only, so nothing from supabase-js is pulled into the edge
 * bundle middleware compiles to.
 */
export type EntitlementReader = SupabaseClient;

/**
 * The caller's own entitlement.
 *
 * `maybeSingle()` and not `single()`: no row is a legitimate answer (it means
 * pending), and `single()` turns it into an error, which would route a genuinely
 * pending user down the `unreadable` branch — where the route gate lets them
 * through. The two shapes are not interchangeable here.
 *
 * RLS does the scoping (`entitlements_self_read`), and the `.eq("user_id", …)`
 * is not redundant: without it a policy widened by accident would hand this
 * function somebody else's row and it would read it as the caller's.
 */
export async function readEntitlement(
  supabase: EntitlementReader,
  userId: string,
): Promise<EntitlementRead> {
  if (!userId) {
    // No identity is not a store failure; it is a definitive "not entitled".
    return { kind: "ok", entitlement: NOT_ENTITLED };
  }
  try {
    const { data, error } = await supabase
      .from("entitlements")
      .select(ENTITLEMENT_COLS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      const message =
        typeof error === "object" && error && "message" in error
          ? String((error as { message: unknown }).message)
          : "entitlement read failed";
      return { kind: "unreadable", message };
    }
    if (!data) return { kind: "ok", entitlement: NOT_ENTITLED };
    return { kind: "ok", entitlement: parseEntitlement(data) };
  } catch (err) {
    return {
      kind: "unreadable",
      message: err instanceof Error ? err.message : "entitlement read threw",
    };
  }
}

/**
 * The data layer's refusal.
 *
 * Thrown from `getDataSource()`, which every page, server action and API route
 * that touches data goes through — so a NEW surface is denied by construction
 * rather than by remembering to add a check to it.
 */
export class NotEntitledError extends Error {
  readonly status: EntitlementStatus;

  constructor(status: EntitlementStatus) {
    super(
      status === "suspended"
        ? "This account is suspended."
        : "This account is not active yet.",
    );
    this.name = "NotEntitledError";
    this.status = status;
  }
}

/**
 * Duck-typed on `name`, NEVER `instanceof`, and that is a lesson this codebase
 * already paid for once.
 *
 * Next compiles pages, server actions and route handlers into separate server
 * bundles, each with its own copy of this module and therefore its own copy of
 * the class object. A `NotEntitledError` thrown inside the page bundle is not
 * `instanceof` the action bundle's class — so an `instanceof` check in the
 * layout would silently never match, the guard would fall through, and the shell
 * would render for a pending user. `lib/data/get-source.ts` records the same
 * failure on `failNextWrite`, found by watching a test not fail.
 */
export function isNotEntitled(err: unknown): err is NotEntitledError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "NotEntitledError"
  );
}

/** The status carried by a refusal, for the surface that has to explain it. */
export function refusedStatus(err: unknown): EntitlementStatus {
  const raw = (err as { status?: unknown } | null)?.status;
  return parseStatus(raw);
}

/**
 * The demo seam.
 *
 * `HQ_DEMO=1` has no database and therefore no entitlement, so the gate would be
 * unreachable through the only source the E2E suite can drive — which is matrix
 * row 15's failure shape, on the one mechanism where "unreachable through the
 * app" means "shipped untested". A cookie, for the reason `hq_demo_seed` and
 * `hq_demo_session=expired` are cookies: a browser-driven test needs to change
 * what the SERVER decides mid-journey, and a cookie is the only channel it has.
 *
 * Honoured ONLY under `isDemoMode()` at both call sites, exactly as narrowly as
 * the seed cookie: a deployment that fell back to demo for a missing env var
 * must not let a visitor pick their own entitlement.
 */
export const DEMO_ENTITLEMENT_COOKIE = "hq_demo_entitlement";

export function demoEntitlement(cookieValue: string | undefined): Entitlement {
  return {
    // Absent OR unrecognised → active, which is the opposite default from
    // `NOT_ENTITLED` on purpose and follows `parseSeed`'s rule: demo mode's job
    // is to show the product, and a typo in a seam cookie must not blank it. The
    // fail-closed default belongs to the path where a real person's access is
    // being decided, and this path decides nobody's.
    status:
      cookieValue === "pending" || cookieValue === "suspended" ? cookieValue : "active",
    invited: true,
    plan: "free",
    activatedAt: null,
  };
}
