"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthColumn, AuthTitle, GoogleButton } from "@/components/auth-column";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

/**
 * `/login`, in the authored entry column.
 *
 * WHAT CHANGED. The page was a hand-rolled `.login-wrap` / `.login-box` with a
 * product tagline and a Google button drawn from a 48px viewBox. It is now
 * `templates/auth/Auth.dc.html`'s login screen: the 360px column, the mark, "Log
 * in" at 20/28, Google's own button rendering, and the quiet legal line. The
 * tagline is gone because 06 §C forbids marketing on an auth page, and because
 * "the family job-search cockpit" described a different product from the one
 * this is becoming.
 *
 * WHAT IS NOT HERE, AND WHY IT IS RECORDED RATHER THAN INVENTED. The design also
 * draws an "or" divider, an email and password pair, "Forgot password", and a
 * "Create an account" footer link, with signup, verification and reset as their
 * own screens. None of that ships in this change, and the reason is DEV-014:
 * there is no password identity in this deployment, the verification screen is
 * authored as a six-digit code that Supabase's default confirmation template
 * does not send, and every one of those flows needs a sender identity ADR-011
 * has not decided. A divider under a single button, or a password field that
 * always fails, would each be worse than the button alone.
 *
 * The behaviour underneath is unchanged: `signInWithOAuth({provider:"google"})`
 * over PKCE, the code landing on `/auth/callback`. The scopes are Supabase's
 * defaults, which are identity only.
 */
export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const envReady = getSupabaseEnv() !== null;

  // Surface callback failures (/login?error=auth) without useSearchParams,
  // so the page prerenders with no Suspense plumbing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (code === "not_allowed") {
      // The one failure where "try again" is actively wrong advice: the address
      // is not on the allowlist and no amount of retrying will change that. The
      // database refuses at the door (0001's signup trigger) and this is that
      // refusal in plain English, with the only action that can actually help.
      //
      // Migration 0027 made this branch rare rather than dead: a deployment on
      // 0027 lets any address create an account and holds it at `/pending`, so
      // this now fires only against a database that has not been migrated yet.
      setError(
        "That Google account isn't on the invite list for this app. " +
          "Ask whoever set it up to add your address, then sign in again.",
      );
    } else if (code) {
      setError("Sign-in didn't complete. Try again.");
    }
  }, []);

  async function signInWithGoogle() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          // No `scopes` option, deliberately and permanently. Supabase asks for
          // identity by default; adding a scope here is the only way this app
          // could ever request access to somebody's mail, and DEC-002 says it
          // never does.
          //
          // No `next` either: the callback now defaults to `/`, which resolves
          // the Landing view preference. Naming `/queue` here would pin every
          // sign-in to the queue and make that setting unreachable.
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (oauthError) {
        setError(oauthError.message);
        setBusy(false);
      }
      // On success the browser navigates away to Google.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <AuthColumn testId="login">
      <AuthTitle>Log in</AuthTitle>

      {envReady ? (
        <GoogleButton
          testId="google-signin"
          label={busy ? "Redirecting" : "Continue with Google"}
          onClick={signInWithGoogle}
          disabled={busy}
        />
      ) : (
        <p className="mt-6 text-sm text-text-2">
          Supabase is not configured yet. See{" "}
          <Link href="/setup" className="underline">
            setup
          </Link>
          .
        </p>
      )}

      {error ? (
        <p role="status" data-testid="login-error" className="mt-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </AuthColumn>
  );
}
