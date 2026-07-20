import { redirect } from "next/navigation";
import SetupNotice from "@/components/setup-notice";
import { getSupabaseEnv } from "@/lib/env";
import { fmtDay } from "@/lib/format";
import { fetchPipeline } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Pipeline — Job Search HQ" };

/** Chip tone by status keyword — unknown statuses stay neutral. */
function statusTone(status: string): "ok" | "warn" | "danger" | "accent" | undefined {
  const s = status.toLowerCase();
  if (s.includes("offer")) return "ok";
  if (s.includes("interview") || s.includes("onsite")) return "accent";
  if (s.includes("oa") || s.includes("assessment") || s.includes("screen")) return "warn";
  if (s.includes("reject") || s.includes("withdrawn") || s.includes("closed")) return "danger";
  return undefined;
}

function isUrl(v: string | null): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

export default async function PipelinePage() {
  if (!getSupabaseEnv()) return <SetupNotice />;

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null;
  if (!userId) redirect("/login");

  const { rows, error } = await fetchPipeline(supabase, userId);

  return (
    <>
      <div className="page-head">
        <h1>Pipeline</h1>
        <span className="page-sub">
          {rows.length} {rows.length === 1 ? "application" : "applications"}
        </span>
      </div>

      {error ? (
        <div className="error-box">
          <strong>Couldn&apos;t load the pipeline.</strong>
          <p>
            <code>{error}</code>
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <strong>No applications yet.</strong>
          Rows land here from Gmail capture once confirmation emails arrive —
          nothing is entered by hand.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Title</th>
                <th>Status</th>
                <th>Applied</th>
                <th>Next action</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    {isUrl(a.url) ? (
                      <a href={a.url} target="_blank" rel="noopener noreferrer">
                        {a.company}
                      </a>
                    ) : (
                      a.company
                    )}
                  </td>
                  <td>{a.title}</td>
                  <td>
                    <span className="status-chip" data-tone={statusTone(a.status)}>
                      {a.status}
                    </span>
                  </td>
                  <td className="mono">{fmtDay(a.applied_date)}</td>
                  <td>
                    {a.next_action ?? "—"}
                    {a.next_action_date ? (
                      <span className="page-sub"> ({fmtDay(a.next_action_date)})</span>
                    ) : null}
                  </td>
                  <td>
                    {isUrl(a.evidence) ? (
                      <a href={a.evidence} target="_blank" rel="noopener noreferrer">
                        evidence
                      </a>
                    ) : (
                      a.evidence ?? "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
