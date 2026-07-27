"use client";

import { Upload } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CONNECTION_LIST_LIMIT, MAX_CONNECTION_CHUNK } from "@/lib/data/source";
import type { ConnectionView } from "@/lib/data/view-models";
import { companyNameKey } from "@/lib/data/view-models";
import {
  applyConnectionMapping,
  previewConnections,
  suggestConnectionMapping,
  toImportRows,
  unmappedConnectionHeaders,
  CONNECTION_FIELDS,
  type ConnectionDraft,
  type ConnectionField,
  type ConnectionMapping,
  type ConnectionPreview,
} from "@/lib/referral/connections";
import { clearConnectionsAction, importConnectionsAction } from "@/lib/referral/actions";
import { connectionUrl } from "@/lib/referral/linkedin";

/**
 * The connections surface: the list, the counts, and the map → preview → commit
 * import.
 *
 * P9's philosophy without P9's machinery, and the deviation is stated on screen
 * rather than only in the migration: **this import is not resumable.** The file
 * is parsed on the server and the rows come back to the browser; closing the tab
 * mid-mapping loses the mapping, and the fix is to upload again. That trade is
 * fair here and would not be for the applications importer — a connections
 * export has no per-row decisions in it, so there is nothing to lose but a
 * five-second re-upload.
 *
 * The step gate is `data-step`, derived from state that only a completed action
 * can move, for matrix row 164's reason: a monotonic write counter lives inside
 * one component and the write that advances a wizard is the write that unmounts
 * the counter recording it.
 */

type Step = "idle" | "mapping" | "committing" | "done";

type Parsed = {
  filename: string;
  headers: string[];
  rows: string[][];
  headerRow: number;
  headerReason: string;
  headerUncertain: boolean;
  encoding: string;
};

type Report = { inserted: number; updated: number; skipped: number; deduped: number };

const FIELD_LABELS: Record<ConnectionField, string> = {
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  company: "Company",
  title: "Position",
  profileUrl: "Profile URL",
  connectedOn: "Connected on",
};

export default function ConnectionsSurface({
  connections,
  companies,
  matched,
  universeKeys,
}: {
  connections: ConnectionView[];
  /** Distinct companies across the imported connections. */
  companies: number;
  /** …of those, ones this user is tracking. The number that matters. */
  matched: number;
  /** Normalized names of every company in the user's universe, for the preview. */
  universeKeys: string[];
}) {
  const [step, setStep] = React.useState<Step>("idle");
  const [parsed, setParsed] = React.useState<Parsed | null>(null);
  const [mapping, setMapping] = React.useState<ConnectionMapping | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<Report | null>(null);
  const [busy, setBusy] = React.useState(false);
  const universe = React.useMemo(() => new Set(universeKeys), [universeKeys]);

  const drafts: ConnectionDraft[] = React.useMemo(
    () => (parsed && mapping ? applyConnectionMapping(parsed.rows, mapping) : []),
    [parsed, mapping],
  );
  const preview: ConnectionPreview | null = React.useMemo(
    () => (drafts.length ? previewConnections(drafts, universe) : null),
    [drafts, universe],
  );

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/connections/upload", { method: "POST", body });
      const json = (await res.json()) as Parsed & { error?: string };
      if (!res.ok) {
        // The server's own sentence, verbatim. "Payload too large" tells nobody
        // anything, so every refusal in that route is written to be rendered.
        setError(json.error ?? "That file could not be read.");
        return;
      }
      setParsed(json);
      setMapping(suggestConnectionMapping(json.headers));
      setStep("mapping");
    } catch {
      setError("The upload did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setStep("committing");
    setError(null);
    const rows = toImportRows(drafts);
    const totals: Report = { inserted: 0, updated: 0, skipped: 0, deduped: 0 };
    // Chunked at the SQL function's own bound, so a chunk that works against the
    // fixture works against Postgres. One key per chunk, minted once and reused
    // by nothing else — a retry would replay it and get the first answer back.
    for (let i = 0; i < rows.length; i += MAX_CONNECTION_CHUNK) {
      const result = await importConnectionsAction({
        rows: rows.slice(i, i + MAX_CONNECTION_CHUNK),
        source: "linkedin-export",
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        setBusy(false);
        setStep("mapping");
        setError(
          result.kind === "auth"
            ? "Your session expired. Sign in again and re-upload the file."
            : result.message,
        );
        return;
      }
      totals.inserted += result.inserted;
      totals.updated += result.updated;
      totals.skipped += result.skipped;
      totals.deduped += result.deduped;
    }
    setBusy(false);
    setReport(totals);
    setStep("done");
  }

  async function clearAll() {
    setBusy(true);
    const result = await clearConnectionsAction({ idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (result.ok) {
      toast.success(`Removed ${result.deleted} connections`);
      setStep("idle");
      setParsed(null);
      setReport(null);
    } else {
      toast.error(result.kind === "auth" ? "Your session expired." : result.message);
    }
  }

  return (
    <div
      className="min-w-0 px-4 py-4 sm:px-6"
      data-testid="connections"
      data-step={step}
      data-hydrated="true"
    >
      {connections.length > 0 ? (
        <section className="mb-5" aria-label="Connection coverage">
          <p className="text-sm text-text">
            <strong className="font-semibold">{matched}</strong> of the companies you are
            tracking have someone you already know inside.
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {connections.length.toLocaleString("en-US")} connections across{" "}
            {companies.toLocaleString("en-US")} companies. Re-import any time — matching people
            merge rather than duplicate.
          </p>
          {/* The cap, said where it BITES rather than only in a constant.
              `connections()` reads the first CONNECTION_LIST_LIMIT rows ordered
              by name, so at the ceiling the number above is not "how many you
              have" — it is "how many are being used", and every warm popover
              under-counts for names after the cut. A silent truncation on a
              surface whose headline is a count is the exact shape of lie this
              branch is otherwise careful about. */}
          {connections.length >= CONNECTION_LIST_LIMIT ? (
            <p className="mt-1 text-xs text-warn" data-testid="connections-truncated">
              That is this app&rsquo;s ceiling. Anything past{" "}
              {CONNECTION_LIST_LIMIT.toLocaleString("en-US")} connections, in name order, is
              stored and not used — so warm paths for people later in the alphabet are
              under-counted. Remove all and re-import a trimmed export to change which ones
              count.
            </p>
          ) : null}
        </section>
      ) : null}

      {step === "idle" || step === "done" ? (
        <UploadPanel busy={busy} onFile={upload} />
      ) : null}

      {error ? (
        <p className="mt-3 text-xs text-danger" role="alert" data-testid="connections-error">
          {error}
        </p>
      ) : null}

      {step === "done" && report ? (
        <section
          className="mt-4 rounded-lg border border-border bg-raised p-3"
          data-testid="connections-report"
          aria-label="Import report"
        >
          <p className="text-sm font-medium text-text">Imported</p>
          {/* Four numbers that add up to the file, because only the commit knows
              which bucket a line went to and nobody can re-derive it afterwards
              (matrix row 169). `deduped` covers both the same person twice in
              the file and somebody already held under a profile URL. */}
          <ul className="mt-1 space-y-0.5 text-xs text-text-2">
            <li>{report.inserted} new</li>
            <li>{report.updated} already known, updated</li>
            <li>{report.deduped} duplicates collapsed</li>
            <li>{report.skipped} lines with no name, skipped</li>
          </ul>
        </section>
      ) : null}

      {step === "mapping" && parsed && mapping && preview ? (
        <MappingPanel
          parsed={parsed}
          mapping={mapping}
          preview={preview}
          busy={busy}
          onChange={setMapping}
          onCancel={() => {
            setParsed(null);
            setMapping(null);
            setStep("idle");
          }}
          onCommit={commit}
        />
      ) : null}

      {connections.length > 0 ? (
        <ConnectionList connections={connections} busy={busy} onClear={clearAll} />
      ) : null}
    </div>
  );
}

function UploadPanel({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <section className="rounded-lg border border-border bg-raised p-3" aria-label="Import">
      <p className="text-sm font-medium text-text">Import your LinkedIn connections</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-text-2">
        <li>
          On LinkedIn: Settings &amp; Privacy → Data privacy → Get a copy of your data → pick{" "}
          <em>Connections</em>.
        </li>
        <li>LinkedIn emails you a zip within about ten minutes. Unzip it.</li>
        <li>Upload the <code>Connections.csv</code> inside.</li>
      </ol>
      <p className="mt-2 text-xs text-muted">
        This is LinkedIn&rsquo;s own export, downloaded by you. Nothing here connects to LinkedIn,
        and your file is never sent anywhere but this app.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          ref={input}
          type="file"
          // `sr-only` hides it from sight, NOT from the accessibility tree — a
          // screen reader still lands on it and axe still requires it to have a
          // name. It went red as `label: 1` the first time this page was
          // scanned, which is the sweep working: the visible control is the
          // button beside it and the input's own name has to be stated.
          aria-label="LinkedIn Connections.csv file"
          accept=".csv,.txt,.xlsx"
          className="sr-only"
          data-testid="connections-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            // Cleared so choosing the SAME file twice fires a change event the
            // second time — otherwise a failed upload cannot be retried without
            // picking a different file.
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Upload aria-hidden="true" className="size-4" />
          {busy ? "Reading…" : "Choose file"}
        </Button>
        <span className="text-xs text-muted">.csv or .xlsx, up to 10 MB</span>
      </div>
    </section>
  );
}

function MappingPanel({
  parsed,
  mapping,
  preview,
  busy,
  onChange,
  onCancel,
  onCommit,
}: {
  parsed: Parsed;
  mapping: ConnectionMapping;
  preview: ConnectionPreview;
  busy: boolean;
  onChange: (m: ConnectionMapping) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const unmapped = unmappedConnectionHeaders(parsed.headers, mapping);
  // The one field that must be answered. Everything else is a row being better
  // rather than a row existing.
  const nameMapped = mapping.fullName !== null || mapping.firstName !== null;

  return (
    <section className="mt-4" aria-label="Map columns" data-testid="connections-mapping">
      <p className="text-sm font-medium text-text">{parsed.filename}</p>
      <p className="mt-0.5 text-xs text-muted">
        Row {parsed.headerRow} is the header — {parsed.headerReason}.
        {parsed.encoding !== "utf-8" ? ` Read as ${parsed.encoding}.` : ""}
      </p>
      {parsed.headerUncertain ? (
        <p className="mt-1 text-xs text-warn" data-testid="connections-header-warning">
          That guess is not certain. Check the sample values below before importing.
        </p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {CONNECTION_FIELDS.map((field) => {
          const chosen = mapping[field];
          const samples = chosen
            ? parsed.rows
                .map((r) => (r[chosen.index] ?? "").trim())
                .filter((v) => v !== "")
                .slice(0, 3)
            : [];
          return (
            <li key={field} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <label
                htmlFor={`map-${field}`}
                className="w-28 shrink-0 text-xs font-medium text-text-2"
              >
                {FIELD_LABELS[field]}
              </label>
              <select
                id={`map-${field}`}
                data-testid={`map-${field}`}
                value={chosen ? String(chosen.index) : ""}
                onChange={(e) => {
                  const index = e.target.value === "" ? null : Number(e.target.value);
                  onChange({
                    ...mapping,
                    [field]:
                      index === null
                        ? null
                        : {
                            header: parsed.headers[index] ?? "",
                            index,
                            confidence: 1,
                            source: "alias" as const,
                          },
                  });
                }}
                className="min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
              >
                <option value="">Not imported</option>
                {parsed.headers.map((h, i) => (
                  <option key={`${h}-${i}`} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </select>
              {/* Three live values beside the choice. This is the mechanism
                  behind matrix row 25, not decoration: the 0.82 floor stops the
                  mapper INVENTING a mapping, and showing real data is what stops
                  a plausible-looking one from being accepted. */}
              <span className="min-w-0 truncate text-xs text-muted" title={samples.join(" · ")}>
                {samples.length ? samples.join(" · ") : "—"}
              </span>
            </li>
          );
        })}
      </ul>

      {unmapped.length ? (
        <p className="mt-2 text-xs text-muted" data-testid="connections-unmapped">
          Not imported: {unmapped.join(", ")}. Email addresses are deliberately left out —
          outreach happens on LinkedIn, so there is nothing here that would use them.
        </p>
      ) : null}

      <div className="mt-4 rounded-lg border border-border bg-raised p-3">
        <p className="text-sm font-medium text-text">
          {preview.distinct.toLocaleString("en-US")} people, {preview.companies} companies
        </p>
        <p className="mt-0.5 text-xs text-text-2" data-testid="connections-preview-matched">
          <strong className="font-semibold">{preview.matchedCompanies}</strong> of those companies
          are ones you are tracking.
        </p>
        {preview.unnamed > 0 ? (
          <p className="mt-0.5 text-xs text-muted">
            {preview.unnamed} lines have no name and will be skipped.
          </p>
        ) : null}
        {preview.unreadableDates > 0 ? (
          <p className="mt-0.5 text-xs text-muted">
            {preview.unreadableDates} connection dates could not be read and will be left blank
            rather than guessed.
          </p>
        ) : null}
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {preview.samples.map((s) => (
            <li key={s.rowNumber} className="truncate">
              {s.fullName}
              {s.company ? ` · ${s.company}` : ""}
              {s.title ? ` · ${s.title}` : ""}
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-3 text-xs text-muted">
        This import is not resumable — if you close the tab now, upload the file again.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={busy || !nameMapped || preview.named === 0}
          onClick={onCommit}
          data-testid="connections-commit"
        >
          {busy ? "Importing…" : `Import ${preview.distinct.toLocaleString("en-US")} people`}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!nameMapped ? (
        // Said BESIDE the disabled control rather than after it is pressed —
        // P10's rule. A row with no name is not a person you can ask for
        // anything, so this is the one mapping that cannot be skipped.
        <p className="mt-1 text-xs text-muted" data-testid="connections-needs-name">
          Map a full name (or a first name) before importing.
        </p>
      ) : null}
    </section>
  );
}

function ConnectionList({
  connections,
  busy,
  onClear,
}: {
  connections: ConnectionView[];
  busy: boolean;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <section className="mt-6" aria-label="Your connections">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-text">Your connections</h2>
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Remove all {connections.length}?</span>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={onClear}
              data-testid="connections-clear-confirm"
            >
              Remove
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirming(true)}
            data-testid="connections-clear"
          >
            Remove all
          </Button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-border" data-testid="connections-list">
        {connections.map((c) => (
          <li key={c.id} className="hq-row min-w-0 py-1.5">
            <a
              href={connectionUrl({ profileUrl: c.profileUrl, fullName: c.fullName })}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:underline"
            >
              {c.fullName}
            </a>
            <p className="min-w-0 break-words text-xs text-muted">
              {c.title ? `${c.title} · ` : ""}
              {c.company || "no company listed"}
            </p>
          </li>
        ))}
      </ul>
      <p className="sr-only">
        {/* Keyed off the same normalization the match uses, so a reader with a
            screen reader gets the fact the grid cells are showing. */}
        {connections.filter((c) => (c.companyKey || companyNameKey(c.company)) !== "").length}{" "}
        connections list an employer.
      </p>
    </section>
  );
}
