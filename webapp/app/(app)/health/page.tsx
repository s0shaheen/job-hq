import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { getDataSource } from "@/lib/data/get-source";

export const metadata = { title: "Health — Job Search HQ" };
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const rows = await (await getDataSource()).health();

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Automation health</h1>
        <p className="text-xs text-muted">
          A channel is stale once it passes twice its expected cadence.
        </p>
      </header>

      {rows.length === 0 ? (
        // This page rendered its six column headings over an empty tbody — a
        // bordered strip and nothing else, on the one surface whose entire job
        // is telling you whether the machinery is alive. No rows here does not
        // mean healthy, it means nothing has reported, and that has to be said
        // out loud on the page that would otherwise imply all-clear.
        <EmptyState
          icon={<Activity aria-hidden="true" className="size-8" />}
          title="No runs reported yet"
          body="Each discovery and tracker job records a row here when it finishes. If this is still empty after the next scheduled run, nothing is reaching the app, and an empty queue means an outage rather than a quiet day."
        />
      ) : (
        /* tabIndex + role make the scroll region reachable by keyboard. */
        <div
          className="w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
          role="region"
          aria-label="Automation health table, scrollable"
        >
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-strong bg-raised text-left">
                {["Channel", "Last run", "Fetched", "New", "Errors", "State"].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-muted whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                const stale = h.ageHours === null || h.ageHours > h.cadenceHours * 2;
                return (
                  <tr key={h.channel} className="border-b border-border hover:bg-raised">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{h.channel}</td>
                    <td className="tabular px-3 py-2 whitespace-nowrap text-muted">
                      {h.ageHours === null ? "never" : `${h.ageHours.toFixed(1)} h ago`}
                    </td>
                    {/* A zero with no denominator is unreadable: "0 new of 812
                        fetched" is a quiet day, "0 of 0" is an outage. */}
                    <td className="tabular px-3 py-2 whitespace-nowrap">{h.fetched}</td>
                    <td className="tabular px-3 py-2 whitespace-nowrap">{h.newRows}</td>
                    <td className="tabular px-3 py-2 whitespace-nowrap">{h.errors}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {stale ? <Badge tone="warn">stale</Badge> : <Badge tone="ok">ok</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
