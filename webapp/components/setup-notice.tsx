/**
 * Rendered by every page (and /setup) when Supabase env vars are missing.
 * The app must degrade to instructions, never to a crash.
 */
export default function SetupNotice() {
  return (
    <section className="setup-box">
      <h1>Setup required</h1>
      <p>
        This deployment has no Supabase credentials yet, so nothing can load.
        Two environment variables are required:
      </p>
      <pre>
        <code>
          {"NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co\n"}
          {"NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY"}
        </code>
      </pre>
      <p>
        Both come from the Supabase dashboard: <strong>Project Settings &rarr; API</strong>.
        The anon (public) key is safe in the browser — row-level security does the
        authorization. Never configure a service_role key for this app.
      </p>
      <ol>
        <li>
          Local dev: copy <code>.env.example</code> to <code>.env.local</code>, fill both
          values, restart <code>npm run dev</code>.
        </li>
        <li>
          Vercel: Project &rarr; Settings &rarr; Environment Variables, add both, then
          redeploy (values are inlined at build time).
        </li>
        <li>
          Sign-in also needs the Google provider enabled in Supabase
          (Authentication &rarr; Providers &rarr; Google) — see the README.
        </li>
      </ol>
    </section>
  );
}
