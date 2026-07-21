import { getDataSource } from "@/lib/data/get-source";
import TriageQueue from "./triage-queue";

export const metadata = { title: "Triage — Job Search HQ" };
export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const src = await getDataSource();
  const rows = await src.queue({ limit: 20 });

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Today&rsquo;s queue</h1>
        <p className="text-xs text-muted">
          Roles that match your search and haven&rsquo;t been decided yet.
        </p>
      </header>
      <TriageQueue initial={rows} yoeMax={4} />
    </div>
  );
}
