import { Plus } from "lucide-react";
import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";

export const metadata = { title: "Add" };

/**
 * Placeholder. Add-by-URL is spec §B6 ("I found it myself on LinkedIn"):
 * paste a URL → dedup → the row is created even when the lookup fails,
 * because the URL is the valuable part. No phase in docs/plans/ owns it yet,
 * and this page says so rather than pretending — the same engine already
 * runs behind the sheet's Quick Add tab (tracker.quickadd, every 2 hours),
 * so the honest thing is to point there until this surface is real.
 */
export default function AddPage() {
  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Add a job</h1>
        <p className="text-xs text-muted">For roles you find yourself, outside the scans.</p>
      </header>
      <EmptyState
        icon={<Plus aria-hidden="true" className="size-8" />}
        title="Adding by URL isn't built here yet"
        body="This will take a pasted job URL and create the row, even when the posting can't be read, because the URL is the valuable part. Until then, paste the URL into the Quick Add tab of the HQ sheet; the tracker files it within two hours."
        action={
          <Link href="/queue" className={buttonClass({ variant: "primary" })}>
            Go to Today
          </Link>
        }
      />
    </div>
  );
}
