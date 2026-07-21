import { ListChecks } from "lucide-react";
import Link from "next/link";
import { ExportDialog } from "@/components/export-dialog";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { getDataSource } from "@/lib/data/get-source";
import type { ApplicationView } from "@/lib/data/view-models";

export const metadata = { title: "Pipeline — Job Search HQ" };
export const dynamic = "force-dynamic";

/** Pipeline order, not alphabetical — Postgres would sort "Applied" above
 *  "Inbox" and bury the early stages. Mirrors core/schema.py STATUS_ORDER. */
const ORDER = [
  "Inbox", "Queued", "Applied", "OA", "Screen", "Interview", "Final", "Offer",
  "Rejected", "Withdrawn", "Closed",
];

function tone(status: string) {
  if (status === "Offer") return "ok" as const;
  if (["OA", "Screen", "Interview", "Final"].includes(status)) return "accent" as const;
  if (status === "Applied") return "info" as const;
  if (["Rejected", "Withdrawn", "Closed"].includes(status)) return "neutral" as const;
  return "neutral" as const;
}

export default async function PipelinePage() {
  const rows = await (await getDataSource()).applications();
  const rank = (s: string) => {
    const i = ORDER.indexOf(s);
    return i === -1 ? ORDER.length : i; // a human-invented status sorts last, never vanishes
  };
  const sorted = [...rows].sort((a, b) => rank(a.status) - rank(b.status));

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold">Pipeline</h1>
          <ExportDialog dataset="applications" />
        </div>
        <p className="text-xs text-muted">
          {rows.length} {rows.length === 1 ? "application" : "applications"}
        </p>
      </header>

      {sorted.length === 0 ? (
        <EmptyState
          icon={<ListChecks aria-hidden="true" className="size-8" />}
          title="No applications yet"
          body="Applications appear here when you mark a role interesting, or when a confirmation email arrives. Nothing is ever added by hand."
          action={
            <Link href="/queue" className={buttonClass({ variant: "primary" })}>
              Go to triage
            </Link>
          }
        />
      ) : (
        // The table scrolls INSIDE this container. The page itself never
        // scrolls sideways — asserted at every breakpoint in tests/e2e.
        // tabIndex + role make the scroll region reachable by keyboard.
        // Containing the scroll here is what keeps the PAGE from scrolling
        // sideways, but a scrollable box nobody can focus is just a different
        // accessibility bug — axe caught this one.
        <div
          className="w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
          role="region"
          aria-label="Applications table, scrollable"
        >
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-strong bg-raised text-left">
                {["Company", "Title", "Status", "Applied", "Next action"].map((h) => (
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
              {sorted.map((a: ApplicationView) => (
                <tr key={a.id} className="border-b border-border hover:bg-raised">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{a.company}</td>
                  <td className="px-3 py-2">
                    {a.url ? (
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
                        {a.title}
                      </a>
                    ) : (
                      a.title
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Badge tone={tone(a.status)}>{a.status}</Badge>
                    {a.suggestedStatus ? (
                      <Badge tone="warn" className="ml-1.5">
                        suggests {a.suggestedStatus}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="tabular px-3 py-2 whitespace-nowrap text-muted">
                    {a.appliedDate ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-text-2">{a.nextAction ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
