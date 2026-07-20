import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import NavLinks from "./nav-links";

/**
 * Shell for the signed-in surface: sticky header with nav, the user's email,
 * and sign-out (a plain form post — no client JS required).
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let email: string | null = null;
  if (getSupabaseEnv()) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    email = typeof data?.claims?.email === "string" ? data.claims.email : null;
  }

  return (
    <>
      <header className="app-header">
        <div className="header-inner">
          <span className="brand">Job Search HQ</span>
          <NavLinks />
          <div className="header-right">
            {email ? (
              <>
                <span className="user-email">{email}</span>
                <form action="/auth/signout" method="post">
                  <button type="submit" className="btn btn-ghost">
                    Sign out
                  </button>
                </form>
              </>
            ) : null}
          </div>
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
