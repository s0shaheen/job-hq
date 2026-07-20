import Link from "next/link";
import SetupNotice from "@/components/setup-notice";
import { getSupabaseEnv } from "@/lib/env";

export const metadata = { title: "Setup — Job Search HQ" };

export default function SetupPage() {
  if (getSupabaseEnv()) {
    return (
      <section className="setup-box">
        <h1>Configured</h1>
        <p>
          Supabase env vars are present. Head to <Link href="/login">sign in</Link> or
          straight to <Link href="/queue">the queue</Link>.
        </p>
      </section>
    );
  }
  return <SetupNotice />;
}
