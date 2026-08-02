"use client";

import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { Select } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { STATUSES } from "@/lib/status";
import { cn } from "@/lib/utils";
import { setImportMappingAction } from "./actions";
import { fieldCopy, REQUIRED_FIELDS } from "./fields";
import type { MapModel } from "./prepare";
import { StepHeader, StepShell, useHydrated } from "./step-shell";
import { useWrites } from "./use-writes";

/**
 * Step 1 — which column is which, and what each status word means.
 *
 * The three things this screen exists to prevent, in the order they cost:
 *
 *   1. **A wrong mapping commits silently.** "Contact Company" landing in
 *      `company` produces 300 applications at companies that do not exist, and the
 *      person finds out in a month. So every field shows THREE LIVE VALUES from
 *      the column it is pointed at (matrix row 25). The pre-fill has a hard 0.82
 *      similarity floor beneath which nothing is filled in at all — a confident
 *      wrong guess is worse than no guess, because nobody audits the field that
 *      already looks right (row 26).
 *   2. **A 60-column spreadsheet blows out the mapping UI** (row 27). This is a
 *      scrolling single column of cards, not a wide table: it is the same shape at
 *      375px and at 1920px, and the fixture with 60 headers is in
 *      `layout.spec.ts`'s sweep.
 *   3. **An imported status becomes an untouchable invented status** (row 43).
 *      `statusRank` ranks an invented status above everything and no bot may
 *      touch a row carrying one — right when a person typed it on purpose, a trap
 *      when it arrives 300 times from a column somebody named "Stage". The
 *      vocabulary is closed to `lib/status.ts`, anything unrecognised goes to
 *      Inbox, and the word the file used is kept in the notes. The screen says all
 *      three of those in words rather than doing them quietly.
 *
 * The header-row guess is shown with its evidence and a live toggle, because the
 * one thing a sniffer cannot know is that a file has no header row at all —
 * treating the first application as the column names files that job under a
 * column called "Acme", and nobody finds it until they go looking for that row.
 */

const UNMAPPED = "__unmapped__";

const itemClass =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md pl-7 pr-3 " +
  "py-1 text-xs text-text outline-none data-[highlighted]:bg-raised";

export default function MapStep({
  batchId,
  filename,
  expectedUpdatedAt,
  fields,
  withHeader,
  noHeader,
  headerReason,
  headerUncertain,
  initialNoHeader,
  savedColumnMap,
  savedStatusMap,
}: {
  batchId: string;
  filename: string;
  expectedUpdatedAt: string | null;
  /** `MAPPABLE_FIELDS`, in its order. Passed rather than imported: `map-columns.ts`
   *  is server-only by transitivity, as its own docstring says. */
  fields: string[];
  withHeader: MapModel;
  noHeader: MapModel;
  headerReason: string;
  headerUncertain: boolean;
  initialNoHeader: boolean;
  savedColumnMap: Record<string, number> | null;
  savedStatusMap: Record<string, string> | null;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { pending, writes, run } = useWrites();
  const [noHeaderRow, setNoHeaderRow] = React.useState(initialNoHeader);
  const model = noHeaderRow ? noHeader : withHeader;

  /**
   * The mapping the user is looking at.
   *
   * Seeded from what the server saved if this batch has been mapped before, and
   * from the deterministic suggestion otherwise. Re-seeded when the header-row
   * toggle moves, because a different header row is a different set of columns —
   * keeping the old indices would silently point Company at whatever now sits in
   * that position.
   */
  const seed = React.useCallback(
    (m: MapModel): Record<string, number> => {
      const out: Record<string, number> = {};
      const saved = savedColumnMap;
      for (const field of fields) {
        const from = saved?.[field] ?? m.suggestion[field];
        if (typeof from === "number" && from >= 0 && from < m.headers.length) out[field] = from;
      }
      return out;
    },
    [fields, savedColumnMap],
  );

  const [columnMap, setColumnMap] = React.useState<Record<string, number>>(() => seed(model));
  const shownFor = React.useRef(model.headerRowIndex);
  if (shownFor.current !== model.headerRowIndex) {
    // Re-seeded during render rather than in an effect, so the screen never paints
    // one frame of a mapping that belongs to the other header choice.
    shownFor.current = model.headerRowIndex;
    setColumnMap(seed(model));
  }

  const statusIndex = columnMap.status;
  const statusColumn = statusIndex === undefined ? null : (model.statusColumns[statusIndex] ?? null);

  /**
   * Status overrides, keyed by COLUMN as well as by value.
   *
   * Pointing Status at a different column has to show that column's suggestions,
   * not the previous column's answers under new words — and keying by column makes
   * that fall out instead of needing an effect that resets state.
   */
  const [statusOverrides, setStatusOverrides] = React.useState<Record<string, string>>({});
  const statusKey = (value: string) => `${statusIndex ?? -1}:${value}`;
  const statusFor = (value: string): string => {
    const override = statusOverrides[statusKey(value)];
    if (override) return override;
    // A saved answer only applies to the column it was saved against.
    if (savedStatusMap && savedColumnMap?.status === statusIndex && savedStatusMap[value]) {
      return savedStatusMap[value];
    }
    return statusColumn?.suggested[value]?.status ?? "Inbox";
  };

  const usedTwice = React.useMemo(() => {
    const counts = new Map<number, string[]>();
    for (const [field, index] of Object.entries(columnMap)) {
      counts.set(index, [...(counts.get(index) ?? []), field]);
    }
    return [...counts.entries()].filter(([, fs]) => fs.length > 1);
  }, [columnMap]);

  const roundTrip = columnMap.hqId !== undefined && columnMap.hqVersion !== undefined;
  const missing = REQUIRED_FIELDS.filter((f) => columnMap[f] === undefined);
  // A round-trip file matches by `hq_id`, so its rows do not need a company and a
  // title to be findable — and in that file both columns are engine-owned anyway.
  const blocked = roundTrip ? [] : missing;

  const submit = async () => {
    const statusMap: Record<string, string> = {};
    for (const value of statusColumn?.values ?? []) statusMap[value.value] = statusFor(value.value);

    let result;
    try {
      result = await run(() =>
        setImportMappingAction({
          batchId,
          headerRowIndex: model.headerRowIndex,
          columnMap,
          statusMap,
          expectedUpdatedAt,
        }),
      );
    } catch {
      toast.error("Saving the mapping stopped waiting for the server.", {
        description: "Nothing was changed. Press Continue again.",
        action: { label: "Try again", onClick: () => void submit() },
      });
      return;
    }
    if (!result.ok) {
      toast.error(
        result.kind === "auth"
          ? "Your session expired"
          : result.kind === "conflict"
            ? "This import changed in another tab"
            : "That mapping was not saved",
        { description: result.message },
      );
      return;
    }
    router.refresh();
  };

  const busy = pending > 0;

  /**
   * One field: what it is, where it is coming from, and THREE VALUES that would
   * actually land there.
   *
   * The samples are the whole point of the card and the reason this is not a
   * two-column table of selects. "Contact Company" and "Company" are one word
   * apart in a header list and three values apart on screen — matrix row 25 is
   * about the mapping that commits silently, and the only thing that catches it
   * before the commit is seeing the data.
   *
   * A card rather than a table row, for row 27: sixty of these scroll the same
   * way at 375px as at 1920px, where a table needs a horizontal scroller that
   * hides the samples exactly when there are most of them.
   */
  const fieldCard = (field: string) => {
    const copy = fieldCopy(field);
    const index = columnMap[field];
    const samples = index === undefined ? [] : (model.samples[index] ?? []);
    const required = (REQUIRED_FIELDS as readonly string[]).includes(field) && !roundTrip;
    const ambiguousDates = copy.date ? samples.filter((s) => !s.date) : [];

    return (
      <li
        key={field}
        data-testid={`map-field-${field}`}
        className="rounded-lg border border-border bg-surface px-3 py-2"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 break-words text-xs font-medium text-text">
            {copy.label}
            {required ? (
              <span className="ml-1 text-warn" aria-label="required">
                *
              </span>
            ) : null}
          </span>
          <ColumnSelect
            field={field}
            label={copy.label}
            headers={model.headers}
            value={index}
            disabled={!hydrated || busy}
            onChange={(next) =>
              setColumnMap((current) => {
                const out = { ...current };
                if (next === null) delete out[field];
                else out[field] = next;
                return out;
              })
            }
          />
        </div>
        <p className="mt-0.5 min-w-0 break-words text-2xs text-muted">{copy.help}</p>

        {index === undefined ? (
          // Said, not left blank. An empty card reads as "not loaded yet"; this
          // reads as the decision it is, and unmapped columns are reported (G13).
          <p data-testid={`map-sample-${field}`} className="mt-1.5 text-2xs text-muted">
            Nothing will be imported into this field.
          </p>
        ) : samples.length === 0 ? (
          <p data-testid={`map-sample-${field}`} className="mt-1.5 text-2xs text-warn">
            That column is empty on every row.
          </p>
        ) : (
          <ul
            data-testid={`map-sample-${field}`}
            className="mt-1.5 flex min-w-0 flex-wrap gap-1"
            aria-label={`Sample values for ${copy.label}`}
          >
            {samples.map((sample, i) => (
              <li
                key={`${sample.text}-${i}`}
                className="min-w-0 max-w-full truncate rounded border border-border bg-raised
                           px-1.5 py-0.5 text-2xs text-text-2"
                title={sample.text}
              >
                {sample.text}
              </li>
            ))}
          </ul>
        )}

        {ambiguousDates.length > 0 ? (
          // Beside the value, at the moment the field is pointed at the column —
          // not in a report after 300 rows have landed dateless. `03/04/2026` is
          // 3 April or 4 March and the file does not say which, so `coerceDate`
          // refuses it rather than guessing (matrix row 158).
          <p
            role="status"
            data-testid={`map-date-warning-${field}`}
            className="mt-1.5 flex items-start gap-1.5 text-2xs text-warn"
          >
            <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {ambiguousDates.length === samples.length
                ? "None of these read as a year-first date"
                : `${ambiguousDates.length} of these do not read as a year-first date`}
              , so those rows import with no date rather than a guessed one. Re-format the column
              as 2026-03-04 if the dates matter.
            </span>
          </p>
        ) : null}
      </li>
    );
  };

  return (
    <StepShell step="map" ready={hydrated} writes={writes} pending={pending}>
      <StepHeader
        title="Which column is which?"
        filename={filename}
        step={1}
        detail={
          <>
            {model.dataRows.toLocaleString("en-US")}{" "}
            {model.dataRows === 1 ? "row would be imported" : "rows would be imported"}
            {model.skippedRows > 0
              ? `, and ${model.skippedRows} above the header row would not`
              : ""}
            .
          </>
        }
      />

      <div className="mx-auto max-w-2xl px-4 py-4 sm:px-6">
        {/* The header-row guess, with its evidence. Never silent: the toggle is the
            point of the whole sniff, because "this file has no header row" is the
            one answer no amount of scoring can reach on its own. */}
        <div
          className={cn(
            "rounded-lg border p-3 text-xs",
            headerUncertain
              ? "border-warn-subtle bg-warn-subtle/40 text-text"
              : "border-border bg-raised text-text-2",
          )}
        >
          <p className="min-w-0 break-words">
            {noHeaderRow ? (
              <>
                Treating every row as data.{" "}
                The columns are named by position below.
              </>
            ) : (
              <>
                Row {model.headerRowIndex + 1} holds the column names.{" "}
                {/* The evidence, labelled. `sniffHeaderRow`'s reasons are lowercase
                    fragments ("row 1 names every column…"), and running one on
                    straight after the headline read as a stutter. */}
                Why: {headerReason}.
              </>
            )}
          </p>
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              checked={noHeaderRow}
              disabled={!hydrated || busy}
              data-testid="map-no-header"
              onChange={(e) => setNoHeaderRow(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0 break-words text-text-2">
              The first row is data, not headers
            </span>
          </label>
        </div>

        <ul className="mt-4 space-y-2">
          {fields.filter((f) => !fieldCopy(f).machine).map(fieldCard)}
        </ul>

        {/* The two machine columns, in their own group.
            They are real controls and stay reachable — a round-trip export whose
            header somebody renamed can only be mapped by hand — but they are not
            part of the question an ordinary spreadsheet asks, and eleven cards
            where nine were needed reads as nine plus two mistakes. */}
        <h2 className="mt-5 text-xs font-semibold text-text">Only in files this app exported</h2>
        <p className="mt-1 text-2xs text-muted">
          A round-trip export carries these two columns so edits you make in Excel find their way
          back to the row they came from. An ordinary spreadsheet has neither, and leaving them
          unmapped is the right answer.
        </p>
        <ul className="mt-2 space-y-2">
          {fields.filter((f) => fieldCopy(f).machine).map(fieldCard)}
        </ul>

        {usedTwice.length > 0 ? (
          <p
            role="status"
            data-testid="map-duplicate-warning"
            className="mt-3 flex items-start gap-1.5 text-2xs text-warn"
          >
            <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {usedTwice
                .map(
                  ([index, fs]) =>
                    `${fs.map((f) => fieldCopy(f).label).join(" and ")} both read "${model.headers[index]}"`,
                )
                .join("; ")}
              . That is allowed, and it is rarely what somebody meant.
            </span>
          </p>
        ) : null}

        {/* --- status values ------------------------------------------------ */}
        <section className="mt-5">
          <h2 className="text-xs font-semibold text-text">What your status words mean</h2>
          {statusIndex === undefined ? (
            <p className="mt-1.5 text-2xs text-muted">
              No column is mapped to Status, so every imported row starts at Inbox.
            </p>
          ) : statusColumn === null || statusColumn.distinct === 0 ? (
            <p className="mt-1.5 text-2xs text-muted">
              That column is empty on every row, so every imported row starts at Inbox.
            </p>
          ) : statusColumn.values.length === 0 ? (
            <p data-testid="status-too-many" className="mt-1.5 text-2xs text-warn">
              That column holds {statusColumn.distinct.toLocaleString("en-US")} different values,
              which is too many to be a list of stages. It looks like the wrong column. Imported
              rows will start at Inbox with the file's own word kept in their notes.
            </p>
          ) : (
            <>
              <p className="mt-1 text-2xs text-muted">
                One row per value found in "{model.headers[statusIndex]}". Anything this
                app does not recognise starts at Inbox and
                the word your file used is added to that application's notes, so nothing is
                lost. An import may not invent a stage, because an invented one would freeze the
                row against every update that follows.
              </p>
              <ul className="mt-2 space-y-1.5">
                {statusColumn.values.map((value, i) => {
                  const suggestion = statusColumn.suggested[value.value];
                  const unrecognised = suggestion?.source === "fallback";
                  return (
                    <li
                      key={value.value}
                      data-testid={`status-row-${i}`}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1
                                 rounded-lg border border-border bg-surface px-3 py-2"
                    >
                      <span className="min-w-0 break-words text-xs text-text">
                        {value.value}
                        <span className="tabular ml-1.5 text-2xs text-muted">
                          {value.count} {value.count === 1 ? "row" : "rows"}
                        </span>
                        {unrecognised ? (
                          <span className="ml-1.5 text-2xs text-warn">not recognised</span>
                        ) : null}
                      </span>
                      <StatusSelect
                        index={i}
                        word={value.value}
                        value={statusFor(value.value)}
                        disabled={!hydrated || busy}
                        onChange={(next) =>
                          setStatusOverrides((current) => ({
                            ...current,
                            [statusKey(value.value)]: next,
                          }))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!hydrated || busy || blocked.length > 0}
            onClick={() => void submit()}
            data-testid="map-continue"
          >
            {busy ? "Saving" : "Continue"}
          </Button>
          {blocked.length > 0 ? (
            // The reason, said out loud beside the disabled control. A disabled
            // button with no explanation is a dead end somebody has to guess at.
            <p role="status" data-testid="map-blocked" className="min-w-0 text-2xs text-warn">
              {blocked.map((f) => fieldCopy(f).label).join(" and ")} must be mapped.{" "}
              {blocked.length === 1 ? "It is" : "They are"} how a row is identified, and a row
              without {blocked.length === 1 ? "it" : "them"} cannot be imported at all.
            </p>
          ) : null}
        </div>
      </div>
    </StepShell>
  );
}

/**
 * The column picker — Radix `Select`, not a hand-rolled menu.
 *
 * The reasons `pipeline/status-select.tsx` records apply harder here, because this
 * list can be 60 items long on a 375px screen: a listbox needs typeahead,
 * arrow-key navigation, a collision-aware popover that does not render off-screen,
 * `aria-activedescendant` wiring and focus restoration. Every one is invisible
 * when it works and a keyboard dead end when it does not (matrix row 118).
 */
function ColumnSelect({
  field,
  label,
  headers,
  value,
  disabled,
  onChange,
}: {
  field: string;
  label: string;
  headers: string[];
  value: number | undefined;
  disabled?: boolean;
  onChange: (next: number | null) => void;
}) {
  return (
    <Select.Root
      value={value === undefined ? UNMAPPED : String(value)}
      disabled={disabled}
      onValueChange={(next) => onChange(next === UNMAPPED ? null : Number(next))}
    >
      <Select.Trigger
        aria-label={`Column for ${label}`}
        data-testid={`map-select-${field}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border
                   border-border-strong bg-surface px-2 py-1 text-xs text-text outline-none
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring
                   disabled:opacity-60"
      >
        <span className="min-w-0 truncate">
          <Select.Value placeholder="Unmapped" />
        </span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          // Not the default 0: at the bottom of a phone viewport the popover
          // otherwise sits flush against the edge with its last item under the
          // browser chrome.
          collisionPadding={8}
          className="z-50 max-h-[min(20rem,var(--radix-select-content-available-height))]
                     min-w-[10rem] max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto
                     rounded-lg border border-border bg-surface p-1 shadow-xl"
        >
          <Select.Viewport>
            {/* First, and always present. "Unmapped" has to be a thing you can
                choose, not the absence of a choice — a field the user deliberately
                wants empty is a decision, and it is reported as one (G13). */}
            <Select.Item value={UNMAPPED} className={itemClass}>
              <Select.ItemIndicator className="absolute left-1.5">
                <Check aria-hidden="true" className="size-3.5" />
              </Select.ItemIndicator>
              <Select.ItemText>Unmapped</Select.ItemText>
            </Select.Item>
            <Select.Separator className="my-1 h-px bg-border" />
            {headers.map((header, i) => (
              <Select.Item key={`${header}-${i}`} value={String(i)} className={itemClass}>
                <Select.ItemIndicator className="absolute left-1.5">
                  <Check aria-hidden="true" className="size-3.5" />
                </Select.ItemIndicator>
                <Select.ItemText>{header}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/** One status word → one of ours. The list is `lib/status.ts` and nothing else. */
function StatusSelect({
  index,
  word,
  value,
  disabled,
  onChange,
}: {
  index: number;
  word: string;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <Select.Root value={value} disabled={disabled} onValueChange={onChange}>
      <Select.Trigger
        aria-label={`Stage for "${word}"`}
        data-testid={`status-select-${index}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border
                   border-border-strong bg-surface px-2 py-1 text-xs text-text outline-none
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring
                   disabled:opacity-60"
      >
        <span className="min-w-0 truncate">
          <Select.Value />
        </span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(20rem,var(--radix-select-content-available-height))]
                     min-w-[10rem] overflow-y-auto rounded-lg border border-border bg-surface p-1
                     shadow-xl"
        >
          <Select.Viewport>
            {STATUSES.map((status) => (
              <Select.Item key={status} value={status} className={itemClass}>
                <Select.ItemIndicator className="absolute left-1.5">
                  <Check aria-hidden="true" className="size-3.5" />
                </Select.ItemIndicator>
                <Select.ItemText>{status}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
