import { Badge } from "@/components/ui/badge";
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

      {/* tabIndex + role make the scroll region reachable by keyboard. */}
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
    </div>
  );
}
