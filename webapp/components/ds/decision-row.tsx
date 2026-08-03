"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { Button } from "./button";
import { LogoAvatar } from "./logo-avatar";

/**
 * One pending decision, as the owner's `DecisionRow` composes it: checkbox,
 * 20px logo, company and title on one wrapping line, a four-segment fact line
 * with an optional mismatch chip, and three actions that live on the right.
 *
 * Ported from the design seed's `DecisionRow.jsx` (`_ds_bundle.js`), which is
 * presentational: it takes a `role` bag of pre-formatted strings and no
 * handlers at all. The deviations below are each a consequence of this being a
 * control rather than a picture, and each is stated where it happens.
 *
 * The BUDGET is the guardrail (03 §9): five facts, three actions, one optional
 * chip. Skill chips and the role summary are deliberately absent — they belong
 * to the detail pane, and putting them back here is what the budget forbids.
 */
export type DecisionRowFacts = {
  /** Compensation exactly as published, or "Not listed". */
  pay: string;
  /** "5+ yrs" / "Any" / "Not listed". */
  years: string;
  /** One segment: "Remote, US", "Hybrid, New York". */
  place: string;
  /** "Today" / "2d ago" / "Jul 12", or null when the board never said. */
  age: string | null;
};

export function DecisionRow({
  company,
  title,
  domain,
  facts,
  mismatch = null,
  selected = false,
  cursor = false,
  busy = false,
  showKeyHints = false,
  onToggleSelect,
  onInterested,
  onPass,
  onLater,
}: {
  company: string;
  title: string;
  domain?: string | null;
  facts: DecisionRowFacts;
  /** A reason SENTENCE (02 §5), never a token and never a bare colour. */
  mismatch?: string | null;
  selected?: boolean;
  /** The `j`/`k` cursor is on this row. */
  cursor?: boolean;
  busy?: boolean;
  showKeyHints?: boolean;
  /** `shift` extends the selection from the last row clicked. */
  onToggleSelect: (shift: boolean) => void;
  onInterested: () => void;
  onPass: () => void;
  onLater: () => void;
}) {
  const who = `${company}, ${title}`;

  return (
    <li
      data-testid="decision-row"
      data-cursor={cursor ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      className={cn(
        // The seed's row, verbatim, plus the cursor ring. `group` drives the
        // hover reveal below.
        //
        // `flex-wrap` is the one addition, and it is the phone. The seed has a
        // single 900px viewport, so three buttons and a four-segment fact line
        // always share a line there; at 320-375px with the large type scale
        // they do not, and without a wrap opportunity the buttons paint past
        // the right edge where `overflow-x:hidden` clips them unreachably
        // (`layout.spec.ts` and `resilience.spec.ts` both measured it). Wrapping
        // is what 01 §12.10 asks for — wrap before anything truncates — and it
        // costs a resting row nothing, because the actions are `sr-only` and
        // therefore out of flow until they are revealed.
        "group flex flex-wrap items-start gap-3 border-b border-border px-2 py-3 hover:bg-surface",
        selected ? "bg-selected" : "",
        // The `j`/`k` cursor is a SECOND focus indicator, because the browser's
        // own focus is on the checkbox or on nothing at all while the list is
        // driven by keys.
        //
        // An OUTLINE, not a ring. Tailwind's `ring` compiles to `box-shadow`,
        // and the anti-slop sweep refuses any shadow on a resting element
        // (01 §12: shadows are for things that overlay) — `slop.spec.ts` failed
        // on exactly this. A negative offset pulls it inside the row's box so
        // it does not paint over the divider above and read as a gap.
        cursor ? "outline-2 -outline-offset-2 outline-ring" : "",
      )}
    >
      {/*
        The seed's `RowCheckbox` is a `<span>` with a check glyph — a PICTURE of
        a checkbox. Nothing announces it, nothing focuses it, space does nothing
        on it. So the seed's span survives verbatim as the visual, and a real
        `<input type="checkbox">` sits behind it carrying the state, the name
        and the keyboard. Overlaying rather than restyling with
        `appearance-none` keeps the seed's check mark, which is drawn in
        `var(--accent-fg)` and therefore cannot travel inside a background-image
        data URI.
      */}
      {/*
        A `<span>`, NOT a `<label>` wrapping the input.

        A label that contains its own control re-dispatches a click to that
        control, and under touch emulation that produced a SECOND toggle: the
        box turned on and straight back off, so on a phone a row simply refused
        to stay selected. Playwright caught it as "clicking the checkbox did not
        change its state" on the Pixel 7 project while desktop passed, which is
        the signature of a synthesized second click rather than a flake.

        Nothing is lost. The input carries its own `aria-label`, so it needs no
        label element for its name, and it is stretched over the visual box by
        `absolute inset-0 size-full` — so it IS the hit target at every point a
        label would have covered.
      */}
      <span className="relative mt-0.5 inline-flex shrink-0 items-center">
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${who}`}
          onChange={(e) => onToggleSelect((e.nativeEvent as MouseEvent).shiftKey === true)}
          className="peer absolute inset-0 size-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm border",
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-ring",
            selected ? "border-accent bg-accent" : "border-border-strong bg-surface",
          )}
        >
          {/* The seed hand-draws `M20 6 9 17l-5-5`, which is lucide's own Check
              path — the same glyph, at the same size and stroke weight, from
              the icon set the rest of the app already imports. */}
          {selected ? (
            <Check size={12} strokeWidth={3} color="var(--accent-fg)" aria-hidden />
          ) : null}
        </span>
      </span>

      <LogoAvatar name={company} domain={domain} size={20} className="mt-0.5" />

      {/*
        THE TEXT COLUMN IS NOT CLICKABLE, and that is a refusal rather than an
        oversight.

        The two authoritative sources disagree about what clicking a row does.
        `today-handoff.md` §1 says it opens the DETAIL PANE; the owner's own
        composition wraps each row in `onClick="{{ r.toggle }}"`, which TOGGLES
        SELECTION. Those are different products: one navigates, one mutates a
        selection, and picking either would be resolving a design conflict by
        preference.

        An earlier revision of this file invented a third answer — click opens
        the employer's posting in a new tab — which no source asks for and which
        is redundant twice over: `o` already opens the posting, and the seed's
        `DetailPane` carries its own "Open posting" link. It is removed.

        So nothing here is a control. The checkbox selects, the three buttons
        decide, `o` opens, and clicking the words does nothing until
        ADD-012 is answered.
      */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Wraps, never truncates (01 §2 #5). `break-words` because company and
            title arrive from ATS boards unsanitised and a pasted slug has no
            break opportunity of its own. */}
        {/* `min-w-0` on the two spans, not only `break-words`. A flex item will
            not shrink below its min-content width by default, so an unbroken
            token — a product name, a slug, a pasted URL — widens the item past
            the row and paints out through `overflow-x:hidden`, where it cannot
            be read or scrolled to. `break-words` alone does not reach it; the
            item has to be allowed to be narrower than its longest word first. */}
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span data-testid="row-company" className="min-w-0 font-medium break-words text-text">
            {company}
          </span>
          <span data-testid="row-title" className="min-w-0 break-words text-text-2">
            {title}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums text-muted">
          {/* Segments separated by SPACING alone — no interpunct, no pipe
              (01 §12.27). Each holds its slot; an unstated value already
              arrived as "Not listed". */}
          <span data-testid="fact-pay">{facts.pay}</span>
          <span data-testid="fact-years">{facts.years}</span>
          <span data-testid="fact-place">{facts.place}</span>
          {facts.age ? <span data-testid="fact-age">{facts.age}</span> : null}
          {mismatch ? <Badge variant="warn">{mismatch}</Badge> : null}
        </span>
      </div>

      {/*
        Resting, the actions are not on screen. The seed does that with
        `hidden group-hover:flex`, and `display:none` is a trap here rather than
        in a mock: a control that is not in the accessibility tree cannot be
        tabbed to, so `group-focus-within` can never fire and a keyboard-only
        user has no way to reveal the three buttons at all.

        `sr-only` instead. The buttons stay in the tree and stay focusable, Tab
        reaches them, and reaching them is what un-hides them. Not opacity:
        de-emphasis by opacity is the contrast failure axe reports (01 §2 #4).

        The cursor row shows them outright — the keyboard cursor being on a row
        is the same statement hovering it makes.
      */}
      <span
        className={cn(
          // `ml-auto` so that when the row wraps on a phone the actions still
          // sit against the right edge rather than under the checkbox.
          "ml-auto flex-wrap items-center gap-2",
          cursor
            ? "flex"
            : "sr-only flex group-focus-within:not-sr-only group-hover:not-sr-only",
        )}
      >
        <Button
          // Three plain buttons, as the seed composes them. No primary among
          // them on purpose: "Interested" is not more correct than "Pass", and
          // an accent-filled button on the affirmative one is a nudge on a
          // surface whose whole premise is passing the misses.
          disabled={busy}
          keyHint={showKeyHints ? "i" : undefined}
          onClick={onInterested}
          data-testid={cursor ? "interested" : undefined}
          aria-label={`Interested: ${who}`}
        >
          Interested
        </Button>
        <Button
          disabled={busy}
          keyHint={showKeyHints ? "x" : undefined}
          onClick={onPass}
          data-testid={cursor ? "pass" : undefined}
          aria-label={`Pass: ${who}`}
        >
          Pass
        </Button>
        <Button
          disabled={busy}
          keyHint={showKeyHints ? "s" : undefined}
          onClick={onLater}
          aria-label={`Later: ${who}`}
        >
          Later
        </Button>
      </span>
    </li>
  );
}
