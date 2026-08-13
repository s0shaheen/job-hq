"use client";

import { ArrowRight, Info } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Button, LogoAvatar } from "@/components/ds";
import type { ProposeCompaniesResult } from "@/lib/data/source";
import { neutralizeFormulaLead } from "@/lib/export/delimited";
import { decodeBytes, MAX_UPLOAD_BYTES, sniffFormat } from "@/lib/import/bytes";
import { proposeCompaniesAction } from "../actions";
import { MAX_NAME_LENGTH, MAX_PASTE_NAMES, overlongLines, parsePastedNames } from "../paste";

/**
 * The paste box.
 *
 * It previews the parse BEFORE submitting, and that is the whole design. Splitting
 * a pasted blob into names is guesswork — a CSV column, a comma-joined sentence and
 * a numbered list all look different, and a legal name containing a comma splits in
 * two. Showing the parsed list up front turns that guess into something the person
 * can see and correct in the textarea, instead of finding out later by way of twelve
 * proposals that make no sense. `parsePastedNames` is shared with the write path, so
 * what is previewed is byte-identical to what is written.
 *
 * No streaming, no progress theatre. The write is one transaction; it either lands
 * or it does not, and animating a wait that does not exist would be inventing a
 * process. What DOES happen after a submit is stated: rows go to the review set.
 */
export default function AddForm() {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  /**
   * Where the text in the box came from — the provenance tag the write carries
   * (0008's closed vocabulary; `import` is already in it). Set to `import` when
   * a file fills the box and it STAYS `import` through hand edits, because
   * fixing a bad split does not change where the list came from. Clearing the
   * box ends the gesture and the next paste is a paste again.
   */
  const [origin, setOrigin] = React.useState<"paste" | "import">("paste");
  const fileRef = React.useRef<HTMLInputElement>(null);

  const names = React.useMemo(() => parsePastedNames(text), [text]);
  const overLimit = names.length > MAX_PASTE_NAMES;
  // Long lines are dropped by the parser rather than truncated (truncating would
  // invent a company name), so the form fails each one BY ITS LINE NUMBER — an
  // address into the text still in the box — instead of losing them silently.
  // The rest of the list is unaffected: one bad row never sinks the chunk.
  const overlong = React.useMemo(() => overlongLines(text), [text]);

  const submit = async () => {
    if (pending || names.length === 0 || overLimit) return;
    setPending(true);
    setError(null);
    let res: ProposeCompaniesResult;
    try {
      res = await proposeCompaniesAction({
        names,
        source: origin,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch {
      setPending(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    setPending(false);
    if (!res.ok) {
      // The message stays in the form beside the box, not in a toast that vanishes:
      // it is a correction to make to the text the user still has on screen.
      setError(
        res.kind === "auth"
          ? "Your session expired. Sign in and try again."
          : res.message,
      );
      return;
    }

    const already = res.companies.length - res.added;
    setText("");
    setOrigin("paste");
    if (fileRef.current) fileRef.current.value = "";
    toast(
      res.added === 0
        ? "Those are already in your universe"
        : `Added ${res.added} ${res.added === 1 ? "proposal" : "proposals"}`,
      {
        description:
          res.added === 0
            ? "Nothing new to review."
            : already > 0
              ? `${already} were already there. Review the new ones to record a decision.`
              : "Review them to record a decision on each.",
        action: { label: "Review", onClick: () => router.push("/companies?set=review") },
      },
    );
    // Refresh so the grid's server read picks the new rows up on arrival.
    router.refresh();
  };

  /**
   * The CSV file path — a front door onto the SAME box, never a second parser.
   *
   * The file is read here, in the browser, exactly where the paste has always
   * been parsed: its decoded text lands in the textarea, so the preview, the
   * per-line failures, the bounds and the submit are the one existing flow, and
   * the names previewed are byte-identical to a paste of the same text
   * (issue #202's contract). Nothing new reaches the server — the only write
   * stays `proposeCompaniesAction`, which enforces its own bounds again, as does
   * `app_propose_companies` under it. Landing in the box rather than in a
   * separate preview is also what keeps a bad row FIXABLE: the failure notice
   * names a line, and the line is right there to edit.
   *
   * The refusals reuse `lib/import/bytes.ts` — the wizard's own caps, magic-byte
   * sniff and strict-then-cp1252 decode — so a `.numbers` file, a password-locked
   * workbook or a windows-1252 export behaves identically on both import
   * surfaces. A real workbook is refused rather than parsed: this path reads
   * text, and pretending to read xlsx with a different engine than the wizard's
   * would give the two doors different answers for the same file.
   */
  const readFile = async (file: File) => {
    setFileError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      const cap = MAX_UPLOAD_BYTES / (1024 * 1024);
      setFileError(
        `That file is ${mb} MB and the limit is ${cap} MB. A list of ${MAX_PASTE_NAMES} names is far smaller than that. Export just the company column and try again.`,
      );
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      setFileError("That file could not be read. Check it is still there and try again.");
      return;
    }
    const format = sniffFormat(file.name, bytes);
    if (format.kind === "rejected") {
      setFileError(format.message);
      return;
    }
    if (format.kind === "xlsx") {
      setFileError(
        "That is an Excel workbook. Save the company column as CSV (File → Save As → CSV) and choose that file, or copy the column and paste it above.",
      );
      return;
    }
    setText(decodeBytes(bytes).text);
    setOrigin("import");
    setError(null);
  };

  return (
    // `pb-40` on a phone is a SAFE AREA for the toaster, not spacing.
    //
    // The toast is bottom-anchored and ~75px tall, and this page is almost exactly
    // one screen: typing a second list opens the preview, which pushes the "Add N
    // companies" button down into the toast's strip. With the document exactly the
    // height of the viewport there was nowhere to scroll it clear, so the previous
    // paste's confirmation sat on top of the next one's button — and sonner pauses
    // its dismiss timer while a finger or cursor rests on the toaster, so waiting
    // does not necessarily help either. Reserving room below the form means the page
    // always scrolls far enough to lift the action out from under the strip.
    // (`closeButton` on the Toaster is the other way out, and stays.)
    <div className="mx-auto max-w-2xl px-4 py-6 pb-40 sm:px-6 sm:pb-10">
      {/* What this surface does and does not do, before the input rather than after
          it. A capability note that arrives only in an error message has already
          cost the person their time. */}
      <div className="flex gap-2 rounded-lg border border-border bg-raised p-3 text-xs text-text-2">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <p>
            This adds names, not boards.{" "}
            Pasted companies are tracked, not pulled. Nothing here looks for a job board. When
            discovery later finds one for a name, it upgrades that row in place, so the row
            becomes a real board and your subscription comes with it. Paste a company whose board
            is already known and you get that board straight away. One case still stalls: if the
            board it finds already belongs to another row here (a second spelling, say "Aon PLC"
            next to "Aon"), merging them would move your subscription, so nothing is changed and
            the row stays as a name only. That is recorded in your activity trail, not flagged on
            the row yet.
          </p>
          <p className="mt-1.5 text-muted">
            Describing a universe in words ("Chicago finance, treasury roles") is not wired up
            here yet. That path runs through the discovery agent, on the same schedule.
          </p>
        </div>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-medium text-text-2">Company names</span>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // An emptied box ends the file gesture; the next list is a paste.
            if (e.target.value === "") setOrigin("paste");
          }}
          rows={10}
          data-testid="paste-box"
          placeholder={"Northern Trust\nCboe Global Markets\nGrainger, Aon, Exelon"}
          className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm
                     text-text placeholder:text-muted focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        />
        <span className="mt-1 block text-2xs text-muted">
          One per line, or comma-separated. Up to {MAX_PASTE_NAMES} at a time.
        </span>
      </label>

      {/* The file door onto the same box. Reading happens in `readFile` above;
          everything after it — preview, failures, submit — is the paste flow,
          which is the entire design. */}
      <div className="mt-3 rounded-lg border border-border bg-surface p-3">
        <label className="block text-xs font-medium text-text-2" htmlFor="company-csv">
          Or read them from a CSV file
        </label>
        <input
          ref={fileRef}
          id="company-csv"
          type="file"
          accept=".csv,.tsv,.tab,.txt"
          data-testid="company-csv-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
          }}
          className="mt-1.5 block w-full text-xs text-text-2 file:mr-3 file:rounded-md
                     file:border file:border-border-strong file:bg-surface file:px-2.5
                     file:py-1.5 file:text-xs file:font-medium file:text-text-2
                     hover:file:bg-raised focus-visible:outline-2
                     focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <p className="mt-1 text-2xs text-muted">
          A .csv or .tsv of company names, up to {MAX_UPLOAD_BYTES / (1024 * 1024)} MB. It lands
          in the box above and is previewed the same way. An Excel workbook needs saving as CSV first.
        </p>
        {fileError ? (
          <p role="alert" data-testid="company-csv-error" className="mt-2 text-xs text-danger">
            {fileError}
          </p>
        ) : null}
      </div>

      {/* The parse, previewed. This is the feature. */}
      {text.trim() ? (
        <div
          data-testid="paste-preview"
          className="mt-3 rounded-lg border border-border bg-surface p-3"
        >
          <p className="text-xs font-medium text-text">
            {names.length === 0
              ? "Nothing recognised in that yet"
              : `${names.length} ${names.length === 1 ? "company" : "companies"} will be proposed`}
          </p>
          {names.length > 0 ? (
            // One row per name, the template's shape (`Coverage.dc.html` lines
            // 152-158): the logo, the name, and what happens to it next. The
            // previous version was a wrap of chips, which is denser and says
            // nothing — a person scanning a pasted list is checking that the
            // SPLIT is right, and a row per name is what makes a bad split
            // obvious. The right-hand note is the template's, and it is true
            // here: this path writes names, and discovery finds the board later.
            <ul className="mt-2 overflow-hidden rounded-lg border border-border">
              {names.slice(0, 60).map((n) => (
                <li
                  key={n}
                  className="flex h-9 items-center gap-2 border-b border-border px-3 last:border-b-0"
                >
                  <LogoAvatar name={n} size={16} />
                  <span className="min-w-0 flex-1 truncate font-medium" title={n}>
                    {n}
                  </span>
                  <span className="hidden shrink-0 text-xs text-muted sm:block">
                    Job board will be found automatically
                  </span>
                </li>
              ))}
              {names.length > 60 ? (
                <li className="flex h-9 items-center px-3 text-xs tabular-nums text-muted">
                  {names.length - 60} more, not shown here
                </li>
              ) : null}
            </ul>
          ) : null}
          {overlong.length > 0 ? (
            // Each failed row, by the line it lives on — an address into the box,
            // so it can be fixed rather than hunted. The echoed snippet passes
            // through the export path's formula neutralizer: a hostile cell like
            // `=IMPORTXML(...)` must already be inert here, before anyone copies
            // it back into a spreadsheet.
            <div data-testid="paste-overlong" className="mt-2 text-2xs text-warn">
              <p>
                {overlong.length} {overlong.length === 1 ? "row is" : "rows are"} longer than{" "}
                {MAX_NAME_LENGTH} characters and {overlong.length === 1 ? "was" : "were"} left
                out. Trimming one to a name would invent a company:
              </p>
              <ul className="mt-1">
                {overlong.slice(0, 4).map((o, i) => (
                  <li key={`${o.line}-${i}`} className="truncate tabular-nums">
                    Line {o.line} · {neutralizeFormulaLead(o.name).slice(0, 60)}…
                  </li>
                ))}
                {overlong.length > 4 ? (
                  <li className="tabular-nums">and {overlong.length - 4} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {overLimit ? (
            <p role="alert" className="mt-2 text-2xs text-danger">
              That is {names.length} names; the limit is {MAX_PASTE_NAMES} per paste. Split it
              into smaller pastes.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="paste-error" className="mt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={pending || names.length === 0 || overLimit}
          onClick={() => void submit()}
          data-testid="paste-submit"
        >
          {pending
            ? "Adding"
            : `Add ${names.length || ""} ${names.length === 1 ? "company" : "companies"}`.trim()}
        </Button>
        <Link
          href="/companies?set=review"
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          Review what's waiting
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </div>
    </div>
  );
}
