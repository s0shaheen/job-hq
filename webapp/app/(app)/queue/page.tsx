import { ExportDialog } from "@/components/export-dialog";
import { getDataSource } from "@/lib/data/get-source";
import { bindingConstraint } from "@/lib/data/view-models";
import TriageQueue from "./triage-queue";

export const metadata = { title: "Triage — Job Search HQ" };
export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const src = await getDataSource();
  const rows = await src.queue({ limit: 20 });

  // Read only when there is nothing to show. An empty queue has two causes
  // that look the same and mean opposite things — nothing found versus the
  // profile gating everything out — and only the second is worth a second
  // query. On the ordinary path this costs nothing.
  const constraint = rows.length > 0 ? null : bindingConstraint(await src.jobs());

  return (
    <div className="min-w-0">
      {/* The action sits on the title's line, not below the subtitle: on a
          phone a wrapped button is another row of chrome between the user and
          the first card, which is the fold problem this layout already fixed
          once. */}
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold">Today&rsquo;s queue</h1>
          <ExportDialog dataset="jobs" />
        </div>
        <p className="text-xs text-muted">
          Roles that match your search and haven&rsquo;t been decided yet.
        </p>
      </header>
      <TriageQueue initial={rows} yoeMax={4} constraint={constraint} />
    </div>
  );
}
