import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { emailDisabledReason, getEmailEnv, getServiceEnv } from "@/lib/env";
import { dispatchLifecycleEmail, type DispatchSummary } from "@/lib/email/dispatch";
import type { EmailProvider } from "@/lib/email/provider";
import type { EmailStore } from "@/lib/email/store";
import { ResendProvider } from "@/lib/email/resend";
import { SupabaseEmailStore } from "@/lib/supabase/service";
import { safeHref } from "@/lib/url/safe-href";

/**
 * `/api/email/dispatch` (#203) — the hook where lifecycle sends actually
 * happen, and the reason it is an ENDPOINT rather than code inside anything:
 * activation is `select public.hq_activate_user(…)` in the Supabase SQL editor
 * (docs/RUNBOOK.md § Turning a new signup on). No webapp code runs at that
 * moment, and no HTTP call belongs inside an RPC — mail failure must never
 * cost the action it rides on. So the RPC writes its audit row, and THIS
 * consumes it: a poll, callable any number of times, where every repeat is a
 * no-op because the ledger holds the keys.
 *
 * WHO CALLS IT: a scheduler (a Vercel cron entry, which sends
 * `Authorization: Bearer ${CRON_SECRET}` when that env is set) or the operator
 * with curl after activating someone. Both present the same credential. The
 * schedule itself is NOT armed in this change — the cadence decision rides the
 * owner's Resend slot, since until the key exists every tick would only record
 * skips.
 *
 * AUTH: constant-time comparison against `CRON_SECRET`, the capture lane's
 * digest-then-timingSafeEqual idiom (hashing first makes the lengths equal, so
 * a truncated guess cannot throw). One failure answer for absent, malformed,
 * and wrong (no oracle). Unconfigured is 503, not open: a deployment without
 * the secret has no callers, not anonymous ones.
 */

const AUTH_FAILED = "Unauthorized.";

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const presented = header.slice("bearer ".length).trim();
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(presented).digest(),
  );
}

export type EmailDispatchResponse = DispatchSummary & {
  /** "" when email is on; otherwise the named reason every skip carried. */
  disabled: string;
};

/**
 * Injectable for the unit suite (real `Request`s, fixture store and provider).
 * Absent, the route wires the real store and — only when the flag is on — the
 * real provider. `provider` uses `null` for "flag off" and `undefined` for
 * "build from env", so a test can exercise the disabled path explicitly.
 */
export async function handleEmailDispatch(
  request: Request,
  store?: EmailStore,
  provider?: EmailProvider | null,
): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return fail("This deployment has no dispatch secret; email dispatch is not callable.", 503);
  }
  if (!authorized(request)) return fail(AUTH_FAILED, 401);

  if (!store && !getServiceEnv()) {
    return fail("This deployment has no store credential; email dispatch cannot read the ledger.", 503);
  }

  // A configured-but-unsafe sign-in URL is a refusal, not an omission: the
  // template would silently drop the link forever, and a misconfiguration that
  // only subtracts is the kind nobody notices.
  const rawAppUrl = process.env.EMAIL_APP_URL ?? "";
  const appUrl = safeHref(rawAppUrl);
  if (rawAppUrl && !appUrl) {
    return fail("EMAIL_APP_URL is set but is not a safe absolute http(s) URL.", 503);
  }

  const emailEnv = getEmailEnv();
  const backingProvider: EmailProvider | null =
    provider !== undefined ? provider : emailEnv ? new ResendProvider(emailEnv) : null;
  // Named after the EFFECTIVE provider: a test that injects one is on, however
  // the env looks; a null is off with the reason every skipped row will carry.
  const disabled =
    backingProvider === null ? emailDisabledReason() || "email disabled" : "";
  const backingStore = store ?? new SupabaseEmailStore();

  const summary = await dispatchLifecycleEmail({
    store: backingStore,
    provider: backingProvider,
    disabledReason: backingProvider === null ? disabled : undefined,
    appUrl: appUrl || undefined,
  });

  return NextResponse.json({ ...summary, disabled } satisfies EmailDispatchResponse);
}
