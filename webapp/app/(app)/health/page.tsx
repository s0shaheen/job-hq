import { redirect } from "next/navigation";
import SetupNotice from "@/components/setup-notice";
import { getSupabaseEnv } from "@/lib/env";
import { fmtHours, fmtStamp, hoursSince } from "@/lib/format";
import { fetchHealth } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ChannelRun } from "@/lib/types";

export const metadata = { title: "Health — Job Search HQ" };

const TABLE_ROWS = 20;
/** A channel quiet for longer than this gets the warn treatment. */
const STALE_HOURS = 26;

/** Latest run per channel, from the fetched window. */
function channelSummary(rows: ChannelRun[]): Array<{ channel: string; hours: number | null }> {
  const latest = new Map<string, string>();
  for (const r of rows) {
    const prev = latest.get(r.channel);
    if (!prev || r.ran_at > prev) latest.set(r.channel, r.ran_at);
  }
  return [...latest.entries()]
    .map(([channel, ranAt]) => ({ channel, hours: hoursSince(ranAt) }))
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

export default async function HealthPage() {
  if (!getSupabaseEnv()) return <SetupNotice />;

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (typeof data?.claims?.sub !== "string") redirect("/login");

  const { rows, error } = await fetchHealth(supabase);
  const summary = channelSummary(rows);
  const tableRows = rows.slice(0, TABLE_ROWS);

  return (
    <>
      <div className="page-head">
        <h1>Health</h1>
        <span className="page-sub">channel runs, newest first</span>
      </div>

      {error ? (
        <div className="error-box">
          <strong>Couldn&apos;t load channel runs.</strong>
          <p>
            <code>{error}</code>
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <strong>No runs recorded.</strong>
          Once the discovery channels start reporting, every run lands here.
        </div>
      ) : (
        <>
          <div className="strip">
            {summary.map(({ channel, hours }) => (
              <div
                key={channel}
                className={
                  hours !== null && hours > STALE_HOURS ? "strip-item stale" : "strip-item"
                }
              >
                <div className="strip-channel">{channel}</div>
                <div className="strip-hours">{fmtHours(hours)}</div>
              </div>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Ran at</th>
                  <th className="num">Fetched</th>
                  <th className="num">New</th>
                  <th className="num">Filtered</th>
                  <th className="num">Tagged</th>
                  <th className="num">Errors</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.channel}</td>
                    <td className="mono">{fmtStamp(r.ran_at)}</td>
                    <td className="num">{r.fetched ?? "—"}</td>
                    <td className="num">{r.new_rows ?? "—"}</td>
                    <td className="num">{r.filtered ?? "—"}</td>
                    <td className="num">{r.tagged ?? "—"}</td>
                    <td className="num">
                      {r.errors === null || r.errors === undefined || r.errors === 0
                        ? "—"
                        : String(r.errors)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
