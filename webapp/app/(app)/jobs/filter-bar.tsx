"use client";

import { ListFilter, X } from "lucide-react";
import { Popover } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { JobView } from "@/lib/data/view-models";
import {
  enumValues,
  formatGroup,
  type Clause,
  type EnumFieldId,
  type NumberFieldId,
  type OrGroup,
} from "@/lib/grid/filter";
import type { GroupBy } from "@/lib/grid/sort";
import type { GridUrlState } from "@/lib/grid/url-state";
import { cn } from "@/lib/utils";

/**
 * The grid toolbar: the view switcher, active-filter chips, the clause
 * builder, quick search, grouping, and the stated count. Presentational — the
 * grid owns the URL; every control here reports a decision upward and renders
 * whatever state comes back down.
 *
 * One row of h-7 controls at rest, wrapping (never overflowing) as chips
 * accumulate or the viewport narrows: the bar is inside the page's flex
 * column, so anything it cannot wrap would push the grid off the bottom or
 * the side — both are the failure layout.spec.ts exists to catch.
 */

const control =
  "h-7 rounded-md border border-border-strong bg-surface px-2 text-xs text-text " +
  "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring";

export type FilterBarProps = {
  state: GridUrlState;
  q: string;
  countText: string;
  /** Unknown-comp rows among the CURRENT result — the G16 "incl. N unstated". */
  compUnknown: number;
  /** Universe for the builder's enum value lists (all rows, not the filtered
   *  view: a value the current filter hides must stay pickable). */
  rows: JobView[];
  /** The view switcher (G3). A slot rather than an import: the switcher needs
   *  the saved views and the write callbacks, all of which the grid owns. */
  switcher?: React.ReactNode;
  onQChange: (q: string) => void;
  onAddGroup: (group: OrGroup) => void;
  onRemoveGroup: (index: number) => void;
  onGroupChange: (group: GroupBy) => void;
};

export default function FilterBar(props: FilterBarProps) {
  const { state } = props;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
      {/* The view switcher is the single control for which set/view is shown —
          Queue and All postings are its first two entries. A standalone
          Queue/All toggle used to sit here too, so the toolbar carried two
          controls that both said "All postings"; that read as unfinished (the
          owner's stated fear) and made "All postings" an ambiguous test
          locator. One control, in the vocabulary the saved views already use. */}
      {props.switcher}

      <ClauseBuilder rows={props.rows} onAdd={props.onAddGroup} />

      {state.filter.map((group, i) => {
        const label = formatGroup(group);
        const isComp = group.some((c) => c.kind === "number" && c.field === "compMax");
        return (
          <span
            key={`${i}-${label}`}
            data-testid="filter-chip"
            className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md border border-border-strong bg-raised pl-2 pr-1 text-xs text-text-2"
          >
            <span className="truncate">{label}</span>
            {isComp ? (
              // G16 made visible: the keep-rule for unknown comp is stated on
              // the very chip that triggered it, so "why is a no-comp row
              // here?" never needs asking. Excluding them is its own clause
              // (Comp → "is stated"), never a quiet side effect of this one.
              <span className="whitespace-nowrap text-muted">
                · incl. {props.compUnknown} unstated
              </span>
            ) : null}
            <button
              type="button"
              aria-label={`Remove filter: ${label}`}
              onClick={() => props.onRemoveGroup(i)}
              className="shrink-0 rounded p-0.5 text-muted hover:bg-surface hover:text-text"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        );
      })}

      {/* Search sits BEFORE the count in the DOM so that on a phone the
          wrap order is [toggle · Filter · search] over [count]: the rest-state
          bar keeps the exact height the loading skeleton mirrors, and the rail
          does not jump when data lands (the queue's 69px lesson, row 7). */}
      <input
        type="search"
        aria-label="Quick search"
        placeholder="Search postings"
        value={props.q}
        onChange={(e) => props.onQChange(e.target.value)}
        className={cn(control, "ml-auto w-32 min-w-0 sm:w-44")}
      />

      {/* Desktop chrome: the grid is a desktop-first surface and the phone
          bar has no room for a fourth control at rest. Grouping still works
          on a phone through the URL (group=company) — the deep link is the
          state, the select is only one way to write it. */}
      <label className="hidden shrink-0 items-center gap-1.5 text-xs text-muted sm:flex">
        Group
        <select
          aria-label="Group rows"
          value={state.group ?? ""}
          onChange={(e) => props.onGroupChange(e.target.value === "company" ? "company" : null)}
          className={control}
        >
          <option value="">None</option>
          <option value="company">Company</option>
        </select>
      </label>

      {/* Which set, and how big it is against everything — stated, not
          implied. A grid that silently shows a subset is the top-tier trust
          bug the spec names for exports, wearing a different surface. */}
      <p data-testid="grid-count" className="min-w-0 text-xs text-muted">
        {props.countText}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clause builder — a small structured popover, not a wall of inputs. Radix
// owns the open/dismiss/focus behaviour; hand-rolling that is the classic
// own-goal the dialog component already documents.
// ---------------------------------------------------------------------------

/** What the builder offers. `comp` folds the G16 pair in: the numeric ops
 *  compare on the band top, and "is stated / is not stated" emit the explicit
 *  compRange.empty clause the spec demands for excluding unknowns. */
const BUILDER_FIELDS = [
  { id: "company", label: "Company", kind: "text" },
  { id: "title", label: "Title", kind: "text" },
  { id: "location", label: "Location", kind: "text" },
  { id: "workModel", label: "Work model", kind: "enum" },
  { id: "remote", label: "Remote", kind: "remote" },
  { id: "compMax", label: "Comp", kind: "comp" },
  { id: "minYoe", label: "Min YoE", kind: "number" },
  { id: "posted", label: "Posted", kind: "date" },
  { id: "seniority", label: "Seniority", kind: "enum" },
  { id: "status", label: "Status", kind: "enum" },
  { id: "triage", label: "Decision", kind: "enum" },
] as const;

type BuilderField = (typeof BUILDER_FIELDS)[number];

const OPS: Record<BuilderField["kind"], Array<{ v: string; label: string }>> = {
  text: [
    { v: "has", label: "contains" },
    { v: "is", label: "is" },
    { v: "empty-true", label: "is empty" },
    { v: "empty-false", label: "is filled" },
  ],
  enum: [
    { v: "in", label: "is any of" },
    { v: "notin", label: "is none of" },
  ],
  number: [
    { v: "gte", label: "at least" },
    { v: "lte", label: "at most" },
    { v: "between", label: "between" },
  ],
  comp: [
    { v: "gte", label: "at least ($k)" },
    { v: "lte", label: "at most ($k)" },
    { v: "between", label: "between ($k)" },
    { v: "stated", label: "is stated" },
    { v: "unstated", label: "is not stated" },
  ],
  date: [
    { v: "inlast", label: "in last N days" },
    { v: "before", label: "before" },
    { v: "after", label: "after" },
  ],
  remote: [
    { v: "remote", label: "remote only" },
    { v: "onsite-hybrid", label: "onsite or hybrid" },
  ],
};

function ClauseBuilder({
  rows,
  onAdd,
}: {
  rows: JobView[];
  onAdd: (group: OrGroup) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [fieldId, setFieldId] = React.useState<BuilderField["id"]>("company");
  const [op, setOp] = React.useState<string>("has");
  const [text, setText] = React.useState("");
  const [numA, setNumA] = React.useState("");
  const [numB, setNumB] = React.useState("");
  const [date, setDate] = React.useState("");
  const [days, setDays] = React.useState("7");
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());

  const field = BUILDER_FIELDS.find((f) => f.id === fieldId)!;
  const ops = OPS[field.kind];

  const pickField = (id: BuilderField["id"]) => {
    setFieldId(id);
    const next = BUILDER_FIELDS.find((f) => f.id === id)!;
    setOp(OPS[next.kind][0].v);
    setChecked(new Set());
  };

  const clause = buildClause(field, op, { text, numA, numB, date, days, checked });

  const add = () => {
    if (!clause) return;
    onAdd([clause]);
    setOpen(false);
    setText("");
    setNumA("");
    setNumB("");
    setChecked(new Set());
  };

  const needsValue =
    (field.kind === "text" && (op === "has" || op === "is")) ||
    ((field.kind === "number" || field.kind === "comp") &&
      (op === "gte" || op === "lte" || op === "between"));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="secondary">
          <ListFilter aria-hidden="true" className="size-3.5" />
          Filter
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 w-64 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-surface p-3 shadow-xl outline-none"
        >
          <div className="flex flex-col gap-2">
            <select
              aria-label="Filter field"
              value={fieldId}
              onChange={(e) => pickField(e.target.value as BuilderField["id"])}
              className={control}
            >
              {BUILDER_FIELDS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter operator"
              value={op}
              onChange={(e) => setOp(e.target.value)}
              className={control}
            >
              {ops.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>

            {field.kind === "text" && (op === "has" || op === "is") ? (
              <input
                aria-label="Filter value"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
                placeholder={op === "has" ? "text to look for" : "exact value"}
                className={control}
              />
            ) : null}

            {(field.kind === "number" || field.kind === "comp") &&
            (op === "gte" || op === "lte") ? (
              <input
                aria-label="Filter value"
                type="number"
                inputMode="numeric"
                value={numA}
                onChange={(e) => setNumA(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
                placeholder={field.kind === "comp" ? "e.g. 150" : "e.g. 3"}
                className={control}
              />
            ) : null}

            {(field.kind === "number" || field.kind === "comp") && op === "between" ? (
              <div className="flex items-center gap-2">
                <input
                  aria-label="Minimum"
                  type="number"
                  inputMode="numeric"
                  value={numA}
                  onChange={(e) => setNumA(e.target.value)}
                  className={cn(control, "min-w-0 flex-1")}
                />
                <span className="text-xs text-muted">to</span>
                <input
                  aria-label="Maximum"
                  type="number"
                  inputMode="numeric"
                  value={numB}
                  onChange={(e) => setNumB(e.target.value)}
                  className={cn(control, "min-w-0 flex-1")}
                />
              </div>
            ) : null}

            {field.kind === "date" && op === "inlast" ? (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  aria-label="Days"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className={cn(control, "w-20")}
                />
                days
              </label>
            ) : null}

            {field.kind === "date" && (op === "before" || op === "after") ? (
              <input
                aria-label="Filter date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={control}
              />
            ) : null}

            {field.kind === "enum" ? (
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5">
                {enumValues(rows, field.id as EnumFieldId).map((v) => (
                  <label key={v} className="flex min-w-0 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={checked.has(v)}
                      onChange={(e) => {
                        const next = new Set(checked);
                        if (e.target.checked) next.add(v);
                        else next.delete(v);
                        setChecked(next);
                      }}
                    />
                    <span className="truncate">{v}</span>
                  </label>
                ))}
              </div>
            ) : null}

            <div className="mt-1 flex justify-end">
              <Button size="sm" variant="primary" disabled={!clause} onClick={add}>
                Add filter
              </Button>
            </div>
            {needsValue && !clause ? (
              <p className="text-2xs text-muted">Enter a value to add this filter.</p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Null while the inputs cannot make a valid clause — Add stays disabled, so a
 *  half-typed filter can never reach the URL. */
function buildClause(
  field: BuilderField,
  op: string,
  v: {
    text: string;
    numA: string;
    numB: string;
    date: string;
    days: string;
    checked: ReadonlySet<string>;
  },
): Clause | null {
  const num = (s: string) => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  switch (field.kind) {
    case "text": {
      const f = field.id as "company" | "title" | "location";
      if (op === "empty-true") return { kind: "text", field: f, op: "empty", value: true };
      if (op === "empty-false") return { kind: "text", field: f, op: "empty", value: false };
      if (v.text.trim() === "") return null;
      return { kind: "text", field: f, op: op as "has" | "is", value: v.text };
    }
    case "enum": {
      if (v.checked.size === 0) return null;
      return {
        kind: "enum",
        field: field.id as EnumFieldId,
        op: op as "in" | "notin",
        values: [...v.checked],
      };
    }
    case "number":
    case "comp": {
      if (op === "stated") return { kind: "text", field: "compRange", op: "empty", value: false };
      if (op === "unstated")
        return { kind: "text", field: "compRange", op: "empty", value: true };
      const f = field.id as NumberFieldId;
      if (op === "between") {
        const lo = num(v.numA);
        const hi = num(v.numB);
        if (lo === null || hi === null || lo > hi) return null;
        return { kind: "number", field: f, op: "between", min: lo, max: hi };
      }
      const n = num(v.numA);
      if (n === null) return null;
      return { kind: "number", field: f, op: op as "gte" | "lte", value: n };
    }
    case "date": {
      if (op === "inlast") {
        const d = num(v.days);
        if (d === null || d < 1 || !Number.isInteger(d)) return null;
        return { kind: "date", field: "posted", op: "inlast", days: d };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return null;
      return { kind: "date", field: "posted", op: op as "before" | "after", value: v.date };
    }
    case "remote":
      return { kind: "remote", value: op as "remote" | "onsite-hybrid" };
  }
}
