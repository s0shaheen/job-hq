/**
 * THE LIVE LANE'S ENV CONTRACT, AND THE REFUSAL THAT PROTECTS PRODUCTION.
 *
 * This module is deliberately pure — no network, no Playwright, no `process`
 * capture at import time — so every rule in it is provable on a laptop with no
 * credentials at all. That is not tidiness. `17-ui-verification-standard.md` §10
 * names three gates in this repo that passed while proving nothing, and a lane
 * whose only correctness argument is "it went green against a database we cannot
 * see" is the fourth one waiting to happen.
 *
 * Two failure modes are being designed against, and they pull in opposite
 * directions:
 *
 *   1. THE LANE RUNS AGAINST PRODUCTION. Catastrophic and irreversible: seeding
 *      creates auth users, and teardown DELETES them. A typo'd env var in a
 *      workflow secret is all it takes. So the production ref is a hardcoded
 *      denylist, checked on the URL, the ref, and the service key's own embedded
 *      project ref — three places, because a URL can be an alias.
 *
 *   2. THE LANE SILENTLY SELF-SKIPS AND REPORTS SUCCESS. This is exactly what
 *      `tests/db` did before the honest-gate banner: 588 cases covering RLS and
 *      entitlement did not run, and pytest exited 0. A live lane is the ONLY
 *      thing in this estate that can prove RLS filters a rendered table, so a
 *      green run that skipped it is worse than no lane — it retires the ledger's
 *      `live` hole while covering nothing.
 *
 * So absence of credentials is answered TWO different ways depending on who is
 * asking, and the caller states which:
 *
 *   `HQ_LIVE_E2E=1`      — the lane was DEMANDED (CI, release). Missing or
 *                          unsafe credentials are a hard error.
 *   `HQ_LIVE_E2E` unset  — nobody asked. The lane is absent and says so loudly
 *                          in the run summary; it never silently passes as if
 *                          the `live` mode had been covered.
 */

/**
 * The production project ref. Hardcoded, and it must stay hardcoded.
 *
 * Reading it from an env var would let the same misconfiguration that points the
 * lane at production also disarm the check that would have caught it — a guard
 * whose denylist is supplied by the thing it is guarding against is not a guard.
 * The ref is not a secret: it is the public subdomain of the deployment, visible
 * in `NEXT_PUBLIC_SUPABASE_URL` in every browser bundle the product ships.
 */
export const PRODUCTION_REF = "nzqlfjtuufduppdemsal";

/** Names in one place, so the workflow, the README and the code cannot drift. */
export const ENV_NAMES = {
  /** `1` demands the lane. Anything else means it was not asked for. */
  enable: "HQ_LIVE_E2E",
  /** `https://<ref>.supabase.co` for the DEDICATED test project. */
  url: "HQ_LIVE_SUPABASE_URL",
  /** The test project's anon/publishable key. Reaches the browser bundle. */
  anonKey: "HQ_LIVE_SUPABASE_ANON_KEY",
  /** The test project's service_role key. Seeding and teardown only. */
  serviceKey: "HQ_LIVE_SUPABASE_SERVICE_KEY",
  /**
   * The password every synthetic user is created with.
   *
   * Required rather than defaulted. A default here would be a credential
   * committed to this repository that works against whatever project the lane is
   * pointed at, and "it's only the test project" is precisely the assumption the
   * production guard above exists because nobody can rely on.
   */
  password: "HQ_LIVE_SEED_PASSWORD",
} as const;

export interface LiveEnv {
  readonly url: string;
  readonly ref: string;
  readonly anonKey: string;
  readonly serviceKey: string;
  readonly password: string;
}

/** Raised for every refusal below, so a caller can tell "unsafe" from "crashed". */
export class LiveLaneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveLaneRefusal";
  }
}

/**
 * The project ref inside a Supabase URL, or null if this is not one.
 *
 * Anchored on the whole host and on the literal `supabase.` label. A
 * `startsWith`/`includes` check would accept `https://nzqlfjtuufduppdemsal.evil.example`
 * as "not production" while it is in fact a host an attacker chose, and — the
 * direction that actually matters here — would MISS
 * `https://db.nzqlfjtuufduppdemsal.supabase.co`, which is production.
 */
export function projectRef(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  const supabaseAt = labels.indexOf("supabase");
  // `<ref>.supabase.co` — the ref is the label immediately before `supabase`,
  // which also handles `db.<ref>.supabase.co` and `<ref>.supabase.in`.
  if (supabaseAt >= 1) return labels[supabaseAt - 1] ?? null;
  return null;
}

/**
 * A Supabase key is an unsigned-verification JWT whose `ref` claim names its
 * project. Read it, because the URL and the key are set separately and the
 * dangerous combination is a test URL with production's service_role key —
 * which the URL check alone waves straight through.
 *
 * The signature is NOT verified and does not need to be: this is a refusal
 * heuristic, not authentication. An unparseable key yields null and the key
 * check abstains rather than inventing a verdict.
 */
export function refFromKey(key: string): string | null {
  const parts = key.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { ref?: unknown };
    return typeof claims.ref === "string" ? claims.ref : null;
  } catch {
    return null;
  }
}

/**
 * THE PRODUCTION REFUSAL. Throws, never returns a boolean nobody checked.
 *
 * Exported separately from `readLiveEnv` so its counterexample can drive it
 * directly with production's own ref — the mutation that proves this test can
 * fail is "delete this function's body", and a test that only went through
 * `readLiveEnv` would still pass on a missing-var error and prove nothing.
 */
export function assertNotProduction(input: {
  url: string;
  anonKey?: string;
  serviceKey?: string;
}): void {
  const seen: string[] = [];
  const urlRef = projectRef(input.url);
  if (urlRef === PRODUCTION_REF) seen.push(`${ENV_NAMES.url} names it`);
  if (input.anonKey && refFromKey(input.anonKey) === PRODUCTION_REF) {
    seen.push(`${ENV_NAMES.anonKey} carries its ref claim`);
  }
  if (input.serviceKey && refFromKey(input.serviceKey) === PRODUCTION_REF) {
    seen.push(`${ENV_NAMES.serviceKey} carries its ref claim`);
  }
  if (seen.length === 0) return;
  throw new LiveLaneRefusal(
    `REFUSING TO RUN: the live lane is pointed at the PRODUCTION Supabase project ` +
      `(${PRODUCTION_REF}). ${seen.join("; ")}. This lane creates and DELETES auth ` +
      `users and rows; against production that is destruction of real user data. ` +
      `Point ${ENV_NAMES.url} and both keys at the dedicated test project — see ` +
      `webapp/tests/live/README.md.`,
  );
}

/**
 * The URL must be one this lane can reason about at all.
 *
 * A URL with no recognisable project ref is refused rather than allowed: the
 * production check is ref-based, so an unparseable host would slip past it, and
 * "we could not tell whether this is production" must resolve to no, exactly as
 * `getDataSource()` fails closed on an unreadable entitlement.
 */
export function assertKnowableProject(url: string): string {
  const ref = projectRef(url);
  if (!ref) {
    throw new LiveLaneRefusal(
      `REFUSING TO RUN: ${ENV_NAMES.url}=${JSON.stringify(url)} is not a Supabase ` +
        `project URL (expected https://<ref>.supabase.co). The production guard ` +
        `identifies projects by ref, so a URL with no ref cannot be proven safe.`,
    );
  }
  return ref;
}

export type LiveEnvResult =
  /** Demanded and safe. Run it. */
  | { readonly kind: "ready"; readonly env: LiveEnv }
  /**
   * Nobody demanded it and the credentials are not here. NOT a pass: the caller
   * owes the run a loud statement that the live mode was not covered.
   */
  | { readonly kind: "absent"; readonly missing: readonly string[]; readonly notice: string };

/**
 * Resolve the contract. Throws `LiveLaneRefusal` for anything unsafe, and for
 * anything missing WHEN THE LANE WAS DEMANDED.
 *
 * `source` is passed in rather than read from `process.env` so the whole
 * decision table is exercisable without mutating the host's environment — the
 * standard way that kind of test leaks into its neighbours.
 */
export function readLiveEnv(source: Record<string, string | undefined>): LiveEnvResult {
  const demanded = source[ENV_NAMES.enable] === "1";
  const required = [
    ENV_NAMES.url,
    ENV_NAMES.anonKey,
    ENV_NAMES.serviceKey,
    ENV_NAMES.password,
  ] as const;
  const missing = required.filter((name) => !source[name]);

  if (missing.length > 0) {
    if (demanded) {
      throw new LiveLaneRefusal(
        `REFUSING TO PASS: ${ENV_NAMES.enable}=1 demanded the live-data lane and ` +
          `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
          `The live lane is the only thing in this estate that can prove RLS, ` +
          `entitlement and real sessions reach the rendered UI. Skipping it and ` +
          `reporting success is the failure tests/db already paid for. ` +
          `See webapp/tests/live/README.md.`,
      );
    }
    return {
      kind: "absent",
      missing,
      notice: liveLaneAbsentNotice(missing),
    };
  }

  const url = source[ENV_NAMES.url]!;
  const anonKey = source[ENV_NAMES.anonKey]!;
  const serviceKey = source[ENV_NAMES.serviceKey]!;

  // Order matters: prove we can identify the project BEFORE deciding it is not
  // production, or an unparseable URL reads as "not production" and passes.
  const ref = assertKnowableProject(url);
  assertNotProduction({ url, anonKey, serviceKey });

  return {
    kind: "ready",
    env: { url, ref, anonKey, serviceKey, password: source[ENV_NAMES.password]! },
  };
}

/**
 * The banner. Modelled on `tests/conftest.py`'s DATABASE SUITE DID NOT RUN,
 * which is the one mechanism in this repo that demonstrably stopped a silent
 * skip from reading as a pass.
 */
export function liveLaneAbsentNotice(missing: readonly string[]): string {
  return [
    "=".repeat(72),
    "LIVE-DATA BROWSER LANE DID NOT RUN",
    "=".repeat(72),
    `Not set: ${missing.join(", ")}`,
    "",
    "Every browser assertion in this run used HQ_DEMO=1 against FixtureDataSource.",
    "That means this run verified NONE of:",
    "  - middleware redirects driven by a real Supabase session",
    "  - the entitlement gate against real `entitlements` rows",
    "  - RLS filtering a second owner's rows out of a rendered table",
    "  - SupabaseDataSource rendering anything at all",
    "",
    "Do not report this run as covering the `live` mode of the coverage ledger.",
    "To run it: webapp/tests/live/README.md",
    "=".repeat(72),
  ].join("\n");
}
