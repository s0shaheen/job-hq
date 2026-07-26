"use client";

import { Check, Download } from "lucide-react";
import { RadioGroup } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { exportCountsAction, type ExportCounts } from "@/lib/export/actions";
import type { ExportDataset, ExportFormat, ExportScope } from "@/lib/export/scope";
import { cn } from "@/lib/utils";

/**
 * The export dialog.
 *
 * The spec's requirement for this surface is a trust requirement, not a feature
 * one: "Selection semantics are stated in the dialog. Silently exporting only
 * the filtered subset is a top-tier trust bug." So every scope option names the
 * exact number of rows it will produce and says in plain words what is included
 * and what is left out. The counts are read when the dialog opens, so they
 * describe the file that is about to be written rather than the page as it
 * looked on load.
 */

const TIMEOUT_MS = 30_000;

type ScopeOption = {
  value: ExportScope;
  label: string;
  /** What is in, and — more importantly — what is out. */
  detail: (counts: ExportCounts) => string;
  count: (counts: ExportCounts) => number;
};

const COPY: Record<ExportDataset, { noun: string; scopes: ScopeOption[] }> = {
  jobs: {
    noun: "roles",
    scopes: [
      {
        value: "view",
        label: "This view",
        count: (c) => c.view,
        detail: (c) =>
          `The ${c.view} roles still waiting on a decision. Excludes ones you have already ` +
          `decided on, and ones your search profile filtered out.`,
      },
      {
        value: "all",
        label: "Everything",
        count: (c) => c.all,
        detail: (c) =>
          `All ${c.all}, including decided ones and the ones your profile filtered out.`,
      },
    ],
  },
  applications: {
    noun: "applications",
    scopes: [
      {
        value: "view",
        label: "This view",
        count: (c) => c.view,
        detail: (c) => `All ${c.view} in your pipeline — the pipeline has no filters yet.`,
      },
      {
        value: "all",
        label: "Everything",
        count: (c) => c.all,
        detail: (c) => `All ${c.all}. Same as this view, until filters exist.`,
      },
    ],
  },
};

const FORMATS: { value: ExportFormat; label: string; detail: string }[] = [
  {
    value: "xlsx",
    label: "Excel",
    detail: "Frozen header, filters on every column, real dates and numbers.",
  },
  {
    value: "csv",
    label: "CSV",
    detail: "Plain text. Opens anywhere; no formatting.",
  },
];

function filenameFrom(header: string | null): string | null {
  const m = header ? /filename="([^"]+)"/.exec(header) : null;
  return m ? m[1] : null;
}

export function ExportDialog({ dataset }: { dataset: ExportDataset }) {
  const [open, setOpen] = React.useState(false);
  const [counts, setCounts] = React.useState<ExportCounts | null>(null);
  const [scope, setScope] = React.useState<ExportScope>("view");
  const [format, setFormat] = React.useState<ExportFormat>("xlsx");
  const [busy, setBusy] = React.useState(false);
  // Same discipline as the triage queue: the ⌘E hint renders from the server,
  // but nothing is listening until React attaches the handler. The hint stays
  // dim until it is true, so the UI never advertises a shortcut it cannot yet
  // honour — and the tests wait on this flag instead of racing it.
  const [ready, setReady] = React.useState(false);

  const copy = COPY[dataset];

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "e") return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    setReady(true);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    // Counts are decoration for the download itself — if they fail to load the
    // dialog still works, it just cannot promise a number, so it says so.
    exportCountsAction(dataset)
      .then((c) => live && setCounts(c))
      .catch(() => live && setCounts(null));
    return () => {
      live = false;
    };
  }, [open, dataset]);

  const download = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset, scope, format }),
        // Bounded, like every other outbound call in this system. A request
        // with no timeout becomes a spinner that never resolves.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server returned ${res.status}.`);
      }

      const blob = await res.blob();
      const name = filenameFrom(res.headers.get("Content-Disposition")) ?? `export.${format}`;
      const rows = res.headers.get("X-HQ-Rows");

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setOpen(false);
      // Reports what the file actually contains, from the response — not what
      // the dialog predicted before the request went out.
      toast.success(
        rows ? `Exported ${rows} ${rows === "1" ? "row" : "rows"} — ${name}` : `Exported ${name}`,
      );
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "TimeoutError"
          ? "The export took too long. Try a smaller scope."
          : err instanceof Error
            ? err.message
            : "Something went wrong.";
      // The dialog deliberately stays open, with the chosen scope intact.
      toast.error("Couldn't export.", {
        description: message,
        action: { label: "Retry", onClick: () => void download() },
      });
    } finally {
      setBusy(false);
    }
  }, [dataset, scope, format]);

  const rowCount = counts ? copy.scopes.find((s) => s.value === scope)?.count(counts) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="export-open" data-ready={ready}>
          <Download aria-hidden="true" className="size-3.5" /> Export
          {/* `invisible`, not `opacity-40`.
              The intent is right — never advertise a shortcut that is not wired
              yet — and the implementation re-broke the exact rule Kbd's own
              docstring records: an opacity multiplier turns an 8.6:1 token into
              2:1 on screen, and axe DOES flag aria-hidden text for contrast. On a
              slow machine (the Playwright container, a throttled runner) the scan
              lands while `ready` is still false, so the violation is real rather
              than a race artefact. `visibility: hidden` keeps the layout
              identical, so nothing shifts when it appears, and there is no colour
              left to fail. */}
          <Kbd className={cn(!ready && "invisible")}>⌘E</Kbd>
        </Button>
      </DialogTrigger>

      <DialogContent
        title="Export"
        description={`Choose what to include. The file is built when you download it, not from a cached copy.`}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="primary"
              onClick={() => void download()}
              disabled={busy}
              data-testid="export-download"
            >
              {busy
                ? "Preparing…"
                : rowCount === null
                  ? "Download"
                  : `Download ${rowCount} ${rowCount === 1 ? "row" : "rows"}`}
            </Button>
          </>
        }
      >
        <fieldset className="mb-4" data-testid="export-scope">
          <legend className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">
            What to include
          </legend>
          <RadioGroup.Root
            value={scope}
            onValueChange={(v) => setScope(v as ExportScope)}
            className="flex flex-col gap-1.5"
          >
            {copy.scopes.map((opt) => (
              <label
                key={opt.value}
                data-testid={`scope-${opt.value}`}
                className={cn(
                  "flex cursor-pointer gap-2.5 rounded-lg border p-2.5 transition-colors",
                  scope === opt.value
                    ? "border-accent bg-accent-subtle"
                    : "border-border hover:bg-raised",
                )}
              >
                <RadioGroup.Item
                  value={opt.value}
                  className="mt-0.5 size-4 shrink-0 rounded-full border border-border-strong bg-surface
                             data-[state=checked]:border-accent
                             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <RadioGroup.Indicator className="block size-full rounded-full border-[3px] border-surface bg-accent" />
                </RadioGroup.Item>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-1.5 text-sm font-medium text-text">
                    {opt.label}
                    {/* text-2, not muted: a card is always selected, and on
                        accent-subtle the muted token measures 4.28:1 (light) /
                        4.45:1 (dark) — under the AA 4.5 floor for this size. */}
                    <span className="tabular text-xs font-normal text-text-2">
                      {counts ? `${opt.count(counts)} ${copy.noun}` : "counting…"}
                    </span>
                  </span>
                  {/* The scope is spelled out, including what it leaves behind. */}
                  <span className="mt-0.5 block text-xs text-text-2">
                    {counts ? opt.detail(counts) : " "}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup.Root>
        </fieldset>

        <fieldset data-testid="export-format">
          <legend className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">
            Format
          </legend>
          <RadioGroup.Root
            value={format}
            onValueChange={(v) => setFormat(v as ExportFormat)}
            className="grid grid-cols-2 gap-1.5"
          >
            {FORMATS.map((f) => (
              <label
                key={f.value}
                data-testid={`format-${f.value}`}
                className={cn(
                  "cursor-pointer rounded-lg border p-2.5 transition-colors",
                  // The radio inside is sr-only, so its focus ring is computed
                  // on a clipped 1x1 box and paints nothing — a keyboard user
                  // tabbing in saw no change on screen. The card is the visible
                  // thing, so the card carries the ring.
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  format === f.value
                    ? "border-accent bg-accent-subtle"
                    : "border-border hover:bg-raised",
                )}
              >
                <RadioGroup.Item value={f.value} className="sr-only" />
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">{f.label}</span>
                  {/* A real element, not colour: forced-colors (Windows High
                      Contrast) strips the selected card's background and
                      repaints both borders alike, so colour alone left the
                      selection invisible. `invisible` rather than conditional
                      render keeps the card height stable. */}
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 shrink-0 text-accent",
                      format !== f.value && "invisible",
                    )}
                  />
                </span>
                {/* text-2, not muted — same AA-floor failure as the scope
                    cards above. */}
                <span className="mt-0.5 block text-xs text-text-2">{f.detail}</span>
              </label>
            ))}
          </RadioGroup.Root>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
