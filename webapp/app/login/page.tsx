"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

/**
 * One button: Google sign-in via Supabase Auth (PKCE — the @supabase/ssr
 * default). The code lands on /auth/callback, which exchanges it for a
 * session cookie.
 */
export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const envReady = getSupabaseEnv() !== null;

  // Surface callback failures (/login?error=auth) without useSearchParams,
  // so the page prerenders with no Suspense plumbing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error")) {
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
          redirectTo: `${window.location.origin}/auth/callback?next=/queue`,
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
    <div className="login-wrap">
      <div className="login-box">
        <h1>Job Search HQ</h1>
        <p>The family job-search cockpit. Sign in to see your queue.</p>
        {envReady ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={signInWithGoogle}
            disabled={busy}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            {busy ? "Redirecting…" : "Sign in with Google"}
          </button>
        ) : (
          <p>
            Supabase isn&apos;t configured yet — see <Link href="/setup">setup</Link>.
          </p>
        )}
        {error ? <p className="login-error">{error}</p> : null}
      </div>
    </div>
  );
}
