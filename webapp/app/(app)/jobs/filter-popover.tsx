"use client";

/**
 * The Filter control: one popover, one clause at a time.
 *
 * 03 §4's decision, verbatim: "Filter bar keeps its operator power but renders
 * as chips reading in plain language". The 11-operator by 4-kind builder does
 * not go away — it moves OFF the chrome and INTO this popover, and what stays
 * on the toolbar is the readable projection (the chips). 04 §3 records why the
 * builder left the chrome: "The builder is Airtable cosplay for a find-a-row
 * task; power stays available inside the Filter popover".
 *
 * The clause logic below is a MOVE from `filter-bar.tsx` (deleted at this
 * surface's cutover), not a rewrite. `buildClause` is byte-equivalent: it is
 * the guard that keeps a half-typed filter out of the URL, and it has unit
 * tests behind the grammar it emits.
 *
 * Radix owns open/dismiss/focus. Hand-rolling that is the own-goal the repo's
 * dialog component already documents.
 */

import { Filter as FilterIcon } from "lucide-react";
import { Popover } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ds";
import type { JobView } from "@/lib/data/view-models";
import {
  enumValues,
  type Clause,
  type EnumFieldId,
  type NumberFieldId,
  type OrGroup,
} from "@/lib/grid/filter";
import { cn } from "@/lib/utils";

const control =
  "h-7 rounded-md border border-border-strong bg-surface px-2 text-xs text-text " +
  "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring";

/**
 * What the builder offers.
 *
 * Field LABELS route through the dictionary (02 §4): Comp is "Pay", the two
 * location columns read as one "Location & model" on the table but stay two
 * filterable fields here, and "Decision" is already the user-facing word.
 * "Min YoE" becomes "Minimum years" — the abbreviation is chrome nobody outside
 * this repo writes (02 §10's attested-label rule).
 *
 * `comp` folds the unknown-comp pair in: the numeric ops compare on the band
 * top, and "is stated / is not stated" emit the explicit compRange.empty clause
 * the spec demands for excluding unknowns.
 */
const BUILDER_FIELDS = [
  { id: "company", label: "Company", kind: "text" },
  { id: "title", label: "Title", kind: "text" },
  { id: "location", label: "Location", kind: "text" },
  { id: "workModel", label: "Work model", kind: "enum" },
  { id: "remote", label: "Remote", kind: "remote" },
  { id: "compMax", label: "Pay", kind: "comp" },
  { id: "minYoe", label: "Minimum years", kind: "number" },
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
    { v: "gte", label: "above" },
    { v: "lte", label: "below" },
    { v: "between", label: "between" },
    { v: "stated", label: "is stated" },
    { v: "unstated", label: "is not stated" },
  ],
  date: [
    { v: "inlast", label: "in the last N days" },
    { v: "before", label: "before" },
    { v: "after", label: "after" },
  ],
  remote: [
    { v: "remote", label: "remote only" },
    { v: "onsite-hybrid", label: "on-site or hybrid" },
  ],
};

/**
 * The decision values a person picks from, in the dictionary's words.
 *
 * `lib/grid/filter.ts` matches on the ENGINE token ("undecided", "snoozed",
 * "dismissed"), which is exactly the leak 02 §4 closes: the clause keeps the
 * token, the checkbox shows the word. Two arrays, one index.
 */
const DECISION_TOKENS = ["undecided", "interested", "snoozed", "dismissed"] as const;
const DECISION_WORDS = ["Needs decision", "Interested", "Later", "Passed"] as const;

function enumOptionLabel(field: EnumFieldId, value: string): string {
  if (field !== "triage") return value;
  const i = DECISION_TOKENS.indexOf(value as (typeof DECISION_TOKENS)[number]);
  return i === -1 ? value : DECISION_WORDS[i];
}

export type FilterPopoverProps = {
  /** Universe for the enum value lists (all rows, not the filtered view: a
   *  value the current filter hides must stay pickable). */
  rows: JobView[];
  onAdd: (group: OrGroup) => void;
};

export default function FilterPopover({ rows, onAdd }: FilterPopoverProps) {
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
        <Button data-testid="filter-trigger">
          <FilterIcon size={14} strokeWidth={1.75} className="text-muted" aria-hidden />
          Filter
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-testid="filter-popover"
          className="z-40 w-64 max-w-[calc(100vw-16px)] rounded-lg border border-border-strong bg-surface p-3 shadow-[0_8px_24px_rgba(26,26,24,0.12)] outline-none"
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
                placeholder={field.kind === "comp" ? "e.g. 120" : "e.g. 3"}
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
                    <span className="truncate">
                      {enumOptionLabel(field.id as EnumFieldId, v)}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}

            <div className="mt-1 flex justify-end">
              <Button variant="primary" disabled={!clause} onClick={add}>
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
export function buildClause(
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
