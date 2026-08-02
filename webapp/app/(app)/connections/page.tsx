import { Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty";
import { getDataSource } from "@/lib/data/get-source";
import { companyNameKey } from "@/lib/data/view-models";
import ConnectionsSurface from "./connections-surface";

export const metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

/**
 * /connections — the user's own LinkedIn export, and the one screen that puts a
 * number on what it bought them.
 *
 * The headline is `matched`: how many of the companies they are tracking have
 * somebody they already know inside. That is the entire value of the import in
 * one integer, and it is the number that tells them whether re-exporting next
 * month is worth the four clicks.
 *
 * Nothing on this page fetches anything from LinkedIn. The file arrives because
 * a person downloaded it and uploaded it, and the copy says so — a feature that
 * surfaces "who you know at this company" is one people reasonably assume is
 * scraping, and the answer to that assumption is a sentence, not silence.
 */
export default async function ConnectionsPage() {
  const src = await getDataSource();
  const [connections, companies] = await Promise.all([src.connections(), src.companies()]);

  // Matched by normalized key, the same way every other surface matches: a
  // connection's employer is a string LinkedIn wrote and a universe row is one a
  // human curated, and `company_name_key` is the only thing between them.
  const universeKeys = new Set(
    companies.map((c) => companyNameKey(c.name)).filter((k) => k !== ""),
  );
  const connectionKeys = new Set(
    connections.map((c) => c.companyKey || companyNameKey(c.company)).filter((k) => k !== ""),
  );
  const matched = [...connectionKeys].filter((k) => universeKeys.has(k)).length;

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="min-w-0 break-words text-lg font-semibold">Connections</h1>
        <p className="text-xs text-muted">
          Your own LinkedIn export, matched to the companies you are tracking.
        </p>
      </header>

      {connections.length === 0 ? (
        <div className="px-4 py-6 sm:px-6">
          <EmptyState
            icon={<Users aria-hidden="true" className="size-8" />}
            title="No connections imported yet"
            body="Import your LinkedIn connections and every job row will say who you already know at that company. The file stays here; nothing is sent to LinkedIn."
          />
          <div className="mx-auto mt-6 max-w-xl">
            <ConnectionsSurface
              universeKeys={[...universeKeys]}
              connections={[]}
              companies={connections.length}
              matched={0}
            />
          </div>
        </div>
      ) : (
        <ConnectionsSurface
          universeKeys={[...universeKeys]}
          connections={connections}
          companies={connectionKeys.size}
          matched={matched}
        />
      )}
    </div>
  );
}
