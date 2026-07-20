import { redirect } from "next/navigation";
import SetupNotice from "@/components/setup-notice";
import { getSupabaseEnv } from "@/lib/env";
import { fetchQueue } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import QueueList from "./queue-list";

export const metadata = { title: "Queue — Job Search HQ" };

export default async function QueuePage() {
  if (!getSupabaseEnv()) return <SetupNotice />;

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null;
  if (!userId) redirect("/login"); // middleware normally catches this first

  const { rows, error } = await fetchQueue(supabase, userId);

  return (
    <>
      <div className="page-head">
        <h1>Today&apos;s queue</h1>
        <span className="page-sub">
          {rows.length} qualified, untriaged {rows.length === 1 ? "posting" : "postings"}
        </span>
      </div>

      {error ? (
        <div className="error-box">
          <strong>Couldn&apos;t load the queue.</strong>
          <p>
            <code>{error}</code>
          </p>
          <p>Refresh to retry; if it persists, check /health and the Supabase logs.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <strong>Queue&apos;s clear.</strong>
          Nothing qualified and untriaged right now — the discovery channels will
          refill it. Check <a href="/pipeline">the pipeline</a> in the meantime.
        </div>
      ) : (
        <QueueList items={rows} />
      )}
    </>
  );
}
