"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_CHIP_LENGTH, MAX_CHIPS } from "@/lib/profile/criteria";
import { formatDollars, parseDollars } from "@/lib/profile/money";

/**
 * The profile's field controls, shared by `/settings` and the wizard.
 *
 * Written once and used by both surfaces on purpose: the wizard is the same six
 * settings walked one at a time, and two implementations of a chip editor would
 * mean the wizard's list and the settings page's list eventually disagree about
 * what a valid chip is — while the gate only ever sees one of them.
 *
 * Everything here is a native control or a Radix primitive. No hand-rolled
 * dropdown, no hand-rolled focus trap: hard constraint 2 from the build log.
 * A radio group here IS `<input type="radio">`, which already has arrow-key
 * navigation, a roving tabindex and a working label association — every
 * hand-rolled version of that loses at least one of them.
 */

export function Section({
  id,
  title,
  blurb,
  children,
}: {
  /** MUST be a `reasonSetting()` output where one exists — the why-popover and
      the queue's empty state link straight to `#<id>` (plans/README C11). */
  id: string;
  title: string;
  blurb: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      // `scroll-mt`: the anchor link lands under the sticky page header
      // otherwise, and a deep link that scrolls the heading out of sight is the
      // same dead end as a 404 with extra steps.
      className="scroll-mt-20 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={`${id}-heading`} className="text-sm font-semibold">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted">{blurb}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * An editable list of short strings.
 *
 * Add on Enter, remove with the chip's own button. Deliberately not a combobox:
 * these lists are free text (a job title, a country, a work-model token) and an
 * autocomplete over a vocabulary that does not exist would refuse the term
 * somebody actually needs.
 */
export function ChipList({
  id,
  label,
  values,
  onChange,
  placeholder,
  suggestions,
}: {
  id: string;
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional one-click adds. Never a closed set — the field stays free text. */
  suggestions?: readonly string[];
}) {
  const [draft, setDraft] = React.useState("");
  const full = values.length >= MAX_CHIPS;
  // The text box gets its OWN id, suffixed. `id` here is the logical field name
  // and several of those are also the `reasonSetting()` anchor on the section
  // wrapping them — `<section id="countries">` and `<input id="countries">` on
  // one page is a duplicate id, which breaks the label association AND makes
  // `/settings#countries` ambiguous. Found by a strict-mode locator resolving
  // to two elements, which is the browser telling you the HTML is wrong.
  const inputId = `${id}-input`;

  function add(raw: string) {
    const s = raw.trim().slice(0, MAX_CHIP_LENGTH);
    if (!s || full) return;
    // Case-insensitive, matching `parseCriteria` — two chips differing only in
    // case are one filter to the gate, and a list showing the same term twice
    // reads as a bug in the form.
    if (values.some((v) => v.toLowerCase() === s.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, s]);
    setDraft("");
  }

  return (
    <div>
      <label htmlFor={inputId} className="block text-xs font-medium text-text-2">
        {label}
      </label>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid={`${id}-chips`}>
        {values.map((v) => (
          <li key={v}>
            <span className="inline-flex max-w-full items-center gap-1 rounded border border-border-strong bg-raised py-0.5 pl-2 pr-1 text-xs">
              {/* `break-all` on the text, not the chip: the longest real title
                  in the presets is 26 characters and somebody will paste a
                  sentence. A chip that cannot wrap pushes the page sideways,
                  which is the owner's stated fear. */}
              <span className="min-w-0 break-all">{v}</span>
              <button
                type="button"
                data-testid={`${id}-remove`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`Remove ${v}`}
                className="rounded p-0.5 text-muted hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          </li>
        ))}
        {values.length === 0 ? <li className="text-xs text-muted">None yet.</li> : null}
      </ul>
      <div className="mt-2 flex gap-1.5">
        <input
          id={inputId}
          value={draft}
          disabled={full}
          maxLength={MAX_CHIP_LENGTH}
          placeholder={full ? `Limit is ${MAX_CHIPS}` : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // A form with one text input submits on Enter. This field's Enter
            // means "add a chip", and letting it also save the profile is how
            // somebody commits a half-typed list.
            e.preventDefault();
            add(draft);
          }}
          className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        />
        <button
          type="button"
          aria-label={`Add to ${label}`}
          disabled={full || !draft.trim()}
          onClick={() => add(draft)}
          className="shrink-0 rounded-md border border-border-strong bg-surface px-2.5 text-sm text-text-2 hover:bg-raised disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {suggestions?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestions
            .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => add(s)}
                className="rounded border border-dashed border-border-strong px-1.5 py-0.5 text-2xs text-text-2 hover:bg-raised"
              >
                + {s}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

/** A native radio group. One question, two or three answers, each a sentence. */
export function PolicyChoice<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string; body: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-xs font-medium text-text-2">{legend}</legend>
      <div className="mt-1.5 space-y-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm",
              value === o.value ? "border-accent bg-accent-subtle" : "border-border",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}</span>
              {/* On the SELECTED card the body is promoted out of `text-muted`.
                  Matrix row 82, on a new surface: a tint strong enough to read
                  as "this is your answer" is too dark for #707067 at AA — axe
                  measured 4.28:1 the first time this page was swept. The
                  unselected cards keep the muted tone, which is what makes the
                  chosen one legible AS the chosen one. */}
              <span className={cn("block text-xs", value === o.value ? "text-text-2" : "text-muted")}>
                {o.body}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A salary, in dollars.
 *
 * Typed as `200000`, `200k` or `$200,000`, shown as `$200,000` once focus
 * leaves. The stored value is still `comp_min` in thousands, converted by the
 * caller: the gate reads that unit and the audit trail is stamped with it, so
 * the translation belongs at this one boundary rather than in the contract.
 *
 * A plain `<input type="number">` cannot do this — it refuses the `$`, the
 * commas and the `k` — which is how the field ended up labelled "in thousands"
 * with a maximum of 2000 and reading, correctly, as a $2,000 ceiling.
 */
export function MoneyField({
  id,
  label,
  dollars,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  dollars: number;
  hint?: string;
  onChange: (next: number) => void;
}) {
  // Null means "showing the stored value"; a string means somebody is editing.
  const [draft, setDraft] = React.useState<string | null>(null);
  const junk = draft !== null && draft.trim() !== "" && parseDollars(draft) === null;

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-2">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft ?? formatDollars(dollars)}
        placeholder="$120,000"
        // NOTHING happens on focus.
        //
        // The first version swapped the formatted value for a bare number there,
        // so editing would not mean picking commas out of a string. It corrupted
        // the very next edit: focus schedules a React state update, the caret's
        // select-all was computed against the value being replaced, and the
        // typed text landed APPENDED — "$200,000" typed over "$200,000" parsed
        // as $200,000,200,000 and clamped to the $2,000,000 ceiling. Caught by
        // the e2e, and a person clicking in and typing fast would have hit it
        // too. `parseDollars` reads the formatted string back, so there is
        // nothing to swap.
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = parseDollars(e.target.value);
          // Committed on every keystroke that parses, so the preview goes stale
          // against the number on screen rather than one blur behind it.
          if (parsed !== null) onChange(parsed);
        }}
        // Dropping the draft re-formats from the stored value, which is also what
        // discards an unparseable string: the last number that meant something
        // comes back rather than the box keeping text nothing will read.
        onBlur={() => setDraft(null)}
        className={cn(
          "mt-1 w-40 rounded-md border bg-surface px-2 py-1 text-sm tabular focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          junk ? "border-warn" : "border-border-strong",
        )}
      />
      {junk ? (
        <p className="mt-1 text-xs text-warn" data-testid={`${id}-junk`} role="status">
          Type a number, like 200000 or 200k.
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** A bounded number, entered as text so an empty box is not silently a zero. */
export function NumberField({
  id,
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-end gap-2">
      <div>
        <label htmlFor={id} className="block text-xs font-medium text-text-2">
          {label}
        </label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : min}
          onChange={(e) => {
            const n = Number(e.target.value);
            // Clamped here AND in `parseCriteria` AND in the SQL. Not
            // belt-and-braces: this one exists so the PREVIEW is computed over
            // the value that would be saved, rather than over a number the
            // server is about to change under the user.
            onChange(Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : min);
          }}
          className="mt-1 w-24 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        />
      </div>
      {suffix ? <span className="pb-1.5 text-xs text-muted">{suffix}</span> : null}
    </div>
  );
}
