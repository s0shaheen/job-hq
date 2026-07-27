"use client";

import { FileUp, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { StepShell, useHydrated } from "./step-shell";
import { useWrites } from "./use-writes";

/**
 * The front door: a file, or a paste.
 *
 * It posts to `/api/import/upload` rather than calling a server action, and that
 * is not a style choice. Next 15.5.20 defaults a server action's `bodySizeLimit`
 * to 1 MB and throws `ApiError(413)` past it — verified in
 * `node_modules/next/dist/server/app-render/action-handler.js` — and a 2,000-row
 * xlsx is over that. The route owns limits it can explain.
 *
 * Every failure is rendered as the sentence the route sent, in the form, beside
 * the control that produced it — the reason `companies/add` keeps its errors out
 * of a toast: the message is a correction to make to something still on screen.
 */

/**
 * A longer bound than a write gets, because this one is a body transfer.
 *
 * 10 MB over a poor phone connection can legitimately take longer than the 15s a
 * query gets, and abandoning an upload that was about to finish is its own bug.
 * The point is that the bound exists — a fetch that never settles leaves the form
 * disabled forever (matrix row 135). `AbortSignal.timeout` genuinely cancels,
 * unlike a server action, so the socket goes with it.
 */
const UPLOAD_TIMEOUT_MS = 60_000;

export default function UploadPanel({
  maxBytes,
  maxRows,
  children,
}: {
  /** From `lib/import/read.ts`, which is server-only — so the caps arrive as props
   *  rather than being a second set of numbers typed into the copy. */
  maxBytes: number;
  maxRows: number;
  /** The recent-import list, rendered on the server and slotted in above the safe area. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { pending, writes, run } = useWrites();
  const [error, setError] = React.useState<string | null>(null);
  const [filename, setFilename] = React.useState<string | null>(null);
  const [paste, setPaste] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);

  /**
   * One idempotency key per GESTURE, reused by every retry of it.
   *
   * A fresh key per retry is what turns a request whose RESPONSE was lost into a
   * second command — here, a second batch holding the same 2,000 rows (matrix row
   * 136). Reset when the selection changes, because a different file is a
   * different gesture.
   */
  const keyRef = React.useRef<string | null>(null);
  const gestureKey = () => (keyRef.current ??= crypto.randomUUID());

  const post = async (body: BodyInit, headers: Record<string, string>) => {
    setError(null);
    let response: Response;
    try {
      response = await run(() =>
        fetch("/api/import/upload", {
          method: "POST",
          body,
          headers: { ...headers, "x-hq-idempotency-key": gestureKey() },
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        }),
      );
    } catch {
      setError(
        "The upload did not finish — check your connection and try again. Sending the same file twice is safe.",
      );
      return;
    }

    const payload = (await response.json().catch(() => ({}))) as {
      batchId?: string;
      error?: string;
    };
    if (!response.ok || !payload.batchId) {
      // The route's own sentence, verbatim. It names the format, the cap or the
      // fix; a generic "upload failed" would throw that away.
      setError(payload.error ?? `The upload failed (${response.status}).`);
      return;
    }
    router.push(`/import/${payload.batchId}`);
  };

  const submitFile = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    void post(form, {});
  };

  const submitPaste = () => {
    if (!paste.trim()) return;
    void post(JSON.stringify({ paste }), { "content-type": "application/json" });
  };

  const busy = pending > 0;

  return (
    <StepShell step="upload" ready={hydrated} writes={writes} pending={pending}>
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        {/* What this does and what it will not do, before the input rather than
            after it. A capability note that arrives in an error message has
            already cost the person their time. */}
        <div className="flex gap-2 rounded-lg border border-border bg-raised p-3 text-xs text-text-2">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
          <div className="min-w-0">
            <p>
              <strong className="font-semibold text-text">Nothing is written until you say so.</strong>{" "}
              The file is read, you say which column is which, and then you see what every row
              would do before a single one is imported. An import can be undone for 24 hours.
            </p>
            <p className="mt-1.5 text-muted">
              .xlsx or .csv, up to {Math.round(maxBytes / (1024 * 1024))} MB and{" "}
              {maxRows.toLocaleString("en-US")} rows. One sheet per file — a workbook with several
              sheets of data is refused rather than guessed at. Old .xls files and Apple Numbers
              files need exporting first; upload one and it says how.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-surface p-3">
          <label className="block text-xs font-medium text-text-2" htmlFor="import-file">
            Spreadsheet
          </label>
          <input
            ref={fileRef}
            id="import-file"
            type="file"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            data-testid="import-file"
            onChange={(e) => {
              keyRef.current = null; // a different file is a different gesture
              setError(null);
              setFilename(e.target.files?.[0]?.name ?? null);
            }}
            className="mt-1.5 block w-full text-xs text-text-2 file:mr-3 file:rounded-md
                       file:border file:border-border-strong file:bg-surface file:px-2.5
                       file:py-1.5 file:text-xs file:font-medium file:text-text-2
                       hover:file:bg-raised focus-visible:outline-2
                       focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <div className="mt-3">
            <Button
              variant="primary"
              // Disabled until hydrated: before React attaches there is no handler,
              // and a button that looks live and does nothing is worse than one
              // that waits (matrix row 21).
              disabled={!hydrated || busy || !filename}
              onClick={submitFile}
              data-testid="import-upload"
            >
              <FileUp aria-hidden="true" className="size-3.5" />
              {busy ? "Reading…" : "Read the file"}
            </Button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
          <label className="block text-xs font-medium text-text-2" htmlFor="import-paste">
            Or paste rows
          </label>
          <textarea
            id="import-paste"
            value={paste}
            rows={6}
            data-testid="import-paste"
            onChange={(e) => {
              keyRef.current = null;
              setError(null);
              setPaste(e.target.value);
            }}
            placeholder={"Company\tJob title\tStatus\nAcme\tProduct Manager\tApplied"}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-2.5 py-2
                       text-sm text-text placeholder:text-muted focus-visible:outline-2
                       focus-visible:-outline-offset-1 focus-visible:outline-ring"
          />
          <p className="mt-1 text-2xs text-muted">
            Copy the cells out of your spreadsheet, header row included. Tabs, commas and
            semicolons are all read.
          </p>
          <div className="mt-3">
            <Button
              disabled={!hydrated || busy || !paste.trim()}
              onClick={submitPaste}
              data-testid="import-paste-submit"
            >
              {busy ? "Reading…" : "Read the paste"}
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" data-testid="import-error" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

        {children}
      </div>
    </StepShell>
  );
}
