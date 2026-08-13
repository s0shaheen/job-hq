"use client";

import Link from "next/link";
import * as React from "react";
import {
  buttonClass,
  DecisionRow,
  EmptyState,
  Kbd,
  SelectionBar,
} from "@/components/ds";
import { decisionToast, reasonSentence } from "@/lib/dictionary";
import { SNOOZE_DAYS, useDecisions } from "@/app/(app)/jobs/decisions";
import { localIsoDaysFromNow, postedAge } from "@/lib/dates";
import { safeHref } from "@/lib/url/safe-href";
import {
  decisionFacts,
  placeLine,
  type BindingConstraint,
  type JobView,
  type Triage,
} from "@/lib/data/view-models";

/**
 * Today — section 1, "New roles".
 *
 * The owner's composition (`templates/today-triage/TodayTriage.dc.html`) is a
 * single 760px column: page header, an optional digest line, then sections in
 * a fixed order, each rendered ONLY when non-empty. Sections 2 and 3 are
 * absent here and that absence is the design's own answer, not an omission —
 * "Ready to review" reads staged applications (blocked on E2) and "Suggested
 * updates" reads email events (blocked on E1), and 07 §3 says in as many words
 * that Today ships legitimately with §1 alone.
 *
 * **The write CONTRACT is unchanged; the entry point moved by one function.**
 * The controller is `useDecisions`, the queue's own machinery lifted out for
 * Jobs: a fresh `crypto.randomUUID()` idempotency key and `expectedUpdatedAt`
 * on every write, optimistic with an 8s undo, refuse-and-revert when the
 * write cannot reach the store (DEC-011 — the refusal is visible and nothing
 * is ever queued; #222 removed the outbox that once held these), and a
 * conflict that reverts the WHOLE batch because the store applied none of it.
 *
 * One thing genuinely differs and it should be said plainly rather than filed
 * under "same code path": every decision now goes through
 * `setTriageBulkAction`, including a single row, where the old queue called
 * `setTriageAction`. Both validate at the boundary and both are idempotent.
 * It is not a new mechanism, it is this surface adopting Jobs' shipped path.
 *
 * This file owns the rendering loop, the cursor, the selection and the words —
 * 07 §1's line exactly: the redesign changes what controls look like, never
 * how they write.
 */
export default function TodayList({
  initial,
  yoeMax = null,
  constraint = null,
  today,
}: {
  initial: JobView[];
  yoeMax?: number | null;
  /**
   * Set only when the server found postings and the profile removed all of
   * them. Computed on the server because it needs every posting, not the
   * twenty this component was handed.
   */
  constraint?: BindingConstraint | null;
  /**
   * TODAY's date as `YYYY-MM-DD`, resolved once on the server.
   *
   * A DATE STRING, not a timestamp. A timestamp still has to be turned into a
   * calendar day by whoever renders it, and that step reads a local timezone —
   * the server's on the server, the user's in the browser — so "2d ago" and
   * "1d ago" could disagree across hydration. See `postedAge`.
   */
  today: string;
}) {
  /**
   * SEEDED ONCE. The server list is the starting point, not a live feed.
   *
   * This is the queue's original contract and dropping it cost a working undo.
   * A server action re-renders the route it was called from, so once a decision
   * lands the next `initial` no longer contains that posting — `src.queue()`
   * returns undecided rows by definition. `useDecisions` overlays its patches
   * onto whatever base it is handed, so a row missing from the base cannot be
   * patched back: Undo wrote the compensating row to the server correctly and
   * the screen simply never showed it again until a reload.
   *
   * `undo-delivery.spec.ts` caught it — "undo after the flush delivered the
   * decision really undoes it" went red on the first row not returning — and it
   * is the failure mode that spec exists for, one layer further out: the
   * database and the screen disagreeing, with nothing on screen admitting it.
   *
   * Holding the base still also makes `seeded` below honest, and it is why
   * `queue/actions.ts` deliberately does not revalidate this path.
   */
  const [base] = React.useState(initial);
  const { effRows, busy, decide } = useDecisions(base);

  // Decided rows leave. The overlay `useDecisions` maintains is what makes an
  // undo put one back: it patches the row's triage rather than deleting it, so
  // restoring the patch restores the row, in its original position.
  const rows = React.useMemo(() => effRows.filter((j) => j.triage === ""), [effRows]);

  const [cursor, setCursor] = React.useState(0);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const anchorRef = React.useRef<string | null>(null);

  // False until the keydown listener below is actually attached. The rows
  // render on the server with their shortcut hints visible, but nothing is
  // listening until React hydrates — on a slow machine that window is long
  // enough for a real keystroke to vanish. Rather than let the UI promise a
  // shortcut it cannot yet honour, readiness is explicit: the hints stay
  // hidden until it flips, and the E2E tests wait for it instead of racing it.
  const [ready, setReady] = React.useState(false);

  /**
   * How many rows the server handed us when this session STARTED.
   *
   * `base.length`, never `initial.length` — the live prop moves under you. A
   * server action re-renders the route it was called from, so after the last
   * decision the page comes back with an empty queue and `bindingConstraint`
   * answers for it. Reading the live prop put a user who had just cleared their
   * queue on "your countries filtered everything out": a working system telling
   * somebody their settings are broken. Finishing and never-having-had-anything
   * are different states, and only the count at the start tells them apart.
   */
  const seeded = base.length;

  // As rows leave, the cursor stays in range rather than falling off the end.
  const safeIndex = Math.min(cursor, Math.max(0, rows.length - 1));
  const current = rows[safeIndex] ?? null;

  /**
   * The rows the KEYBOARD acts on: the selection when there is one, else the
   * cursor row. A selection on screen is a statement about what is next, and a
   * key is aimed at the surface rather than at any one row.
   *
   * The per-row buttons deliberately do NOT come through here — see `decideRow`.
   */
  const keyboardTargets = React.useCallback((): JobView[] => {
    if (selected.size > 0) return rows.filter((j) => selected.has(j.key));
    return current ? [current] : [];
  }, [rows, selected, current]);

  /**
   * A decision, and whether it came from the selection.
   *
   * `clearsSelection` is not a convenience flag. A gesture aimed at the
   * SELECTION consumes it — the rows are gone, so the selection that named
   * them must go too, and it has to come back if the write reverts. A gesture
   * aimed at ONE ROW must leave the selection exactly as it found it: the user
   * picked those rows for a reason and deciding an unrelated row is not a
   * reason to discard them.
   */
  const submit = React.useCallback(
    (triage: Triage, targets: JobView[], clearsSelection: boolean) => {
      if (targets.length === 0) return;
      const word =
        triage === "interested" ? "Interested" : triage === "dismissed" ? "Passed" : "Later";
      const snapshot = new Set(selected);
      void decide(triage, {
        targets,
        snooze: triage === "snoozed" ? localIsoDaysFromNow(SNOOZE_DAYS) : undefined,
        // 02 §6's exact strings, through the dictionary rather than a literal
        // so this surface and Jobs cannot drift apart. At one row it collapses
        // to the bare verb phrase — "Marked interested", "Passed", "Saved for
        // later" — and Undo is the toast's own right-aligned action, never
        // glued into the message.
        label: decisionToast(word, targets.length),
        // A batch that came back as nothing must leave the screen exactly as it
        // was, and the selection is part of that screen: clearing it optimistically
        // and not restoring it would leave the user re-picking rows the store
        // still holds as undecided.
        onRevert: clearsSelection ? () => setSelected(snapshot) : undefined,
      });
      if (clearsSelection) {
        setSelected(new Set());
        anchorRef.current = null;
      }
    },
    [decide, selected],
  );

  /**
   * A ROW's own button acts on THAT ROW. Only ever that row.
   *
   * This is the whole of 02 §8 — the count on a control equals the count it
   * acts on — and it is a correctness rule, not a copy one. Routing these
   * through the selection meant that with rows 1-3 checked, clicking the button
   * whose accessible name is `Interested: Vanta, …` wrote rows 1-3 and left
   * Vanta undecided, while the toast said "Marked 3 roles interested". The
   * control's name, its position and its effect all disagreed.
   *
   * The selection has its own control two inches away — `SelectionBar`, which
   * states its count on every button — and the keyboard has `keyboardTargets`.
   * A row button is the one affordance that is unambiguously about one row, and
   * `jobs-table.tsx` reaches the same conclusion for the same reason.
   */
  const decideRow = React.useCallback(
    (triage: Triage, job: JobView) => submit(triage, [job], false),
    [submit],
  );

  const toggleSelect = React.useCallback(
    (job: JobView, shift: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const anchor = anchorRef.current;
        // Shift-click extends from the last row clicked, over the rows as
        // DISPLAYED. The design names shift-click and nothing else; there is no
        // range key, because the one the handoff mentions ("an x-range") is `x`,
        // which is already Pass. See the PR's design-gap list.
        if (shift && anchor && anchor !== job.key) {
          const a = rows.findIndex((r) => r.key === anchor);
          const b = rows.findIndex((r) => r.key === job.key);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i].key);
            return next;
          }
        }
        if (next.has(job.key)) next.delete(job.key);
        else next.add(job.key);
        anchorRef.current = job.key;
        return next;
      });
    },
    [rows],
  );

  const openPosting = React.useCallback((job: JobView) => {
    const href = safeHref(job.url);
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  }, []);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // A modal is modal. This handler is on `window`, so with the export
      // dialog open a plain `i` still decided the row hidden behind it — the
      // user is reading a dialog and a decision happens on a row they cannot
      // see. Radix marks the open dialog; nothing else needs to know about it.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (!current) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setCursor(Math.min(safeIndex + 1, rows.length - 1));
          break;
        case "k":
          e.preventDefault();
          setCursor(Math.max(safeIndex - 1, 0));
          break;
        case "i":
          e.preventDefault();
          submit("interested", keyboardTargets(), selected.size > 0);
          break;
        case "x":
          e.preventDefault();
          submit("dismissed", keyboardTargets(), selected.size > 0);
          break;
        case "s":
          e.preventDefault();
          submit("snoozed", keyboardTargets(), selected.size > 0);
          break;
        case "o":
          if (el && /^(A|BUTTON)$/.test(el.tagName)) return;
          e.preventDefault();
          openPosting(current);
          break;
        case "Escape":
          if (selected.size === 0) return;
          e.preventDefault();
          setSelected(new Set());
          anchorRef.current = null;
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    setReady(true);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, rows.length, safeIndex, submit, keyboardTargets, openPosting, selected.size]);

  if (!current) {
    /**
     * Three states wearing one panel is how a working system looks broken, and
     * the copy has to pick the true one (01 §10, 02 §7).
     *
     * FINISHED — rows arrived and the user cleared them. The design's template
     * is "You're done for today." with the next scan's time under it. The time
     * is NOT rendered: the composition's "around 6:00 tomorrow" is a literal in
     * a mock, and the webapp has no read of the monitor's schedule, so a time
     * here would be a number the surface cannot stand behind (01 §2 #8 — a
     * count, or a clock, equals reality). Recorded as a gap.
     */
    if (seeded > 0) {
      return (
        <EmptyState
          title="You're done for today."
          description="New roles arrive with the next scan."
        >
          {/* The composition's child link, kept. Only the TIME was dropped and
              that is the gap noted above; dropping the action too would have
              been a second, unstated deletion — and this is the one moment the
              user has nothing in front of them, which is exactly when the
              product should offer the next thing to look at. */}
          <Link href="/coverage" className={buttonClass({})}>
            Check coverage
          </Link>
        </EmptyState>
      );
    }
    /**
     * GATED — the profile removed everything that was found. Not in the
     * owner's composition, which has three page states and no fourth; it is
     * kept because it is a shipped behaviour and the alternative is telling
     * someone nothing was found when the system found plenty. Its copy is the
     * existing copy.
     */
    if (constraint) {
      return (
        <EmptyState
          title={`Your ${constraint.label} filtered everything out`}
          description={`That setting removed ${constraint.filtered} of the ${constraint.total} postings found. For example: ${constraint.example}.`}
        >
          <Link
            href={`/settings#${constraint.setting}`}
            className={buttonClass({ variant: "primary" })}
          >
            Adjust your {constraint.label}
          </Link>
        </EmptyState>
      );
    }
    /**
     * FIRST RUN — nothing has ever arrived. The design's teaching empty state,
     * and its three actions ARE the onboarding checklist: profile, coverage,
     * import.
     */
    return (
      <EmptyState
        title="Pending decisions collect here after your first scan."
        description="Set up your search profile to start it."
      >
        <Link href="/settings" className={buttonClass({ variant: "primary" })}>
          Set up your search profile
        </Link>
        <Link href="/coverage" className={buttonClass({})}>
          Check coverage
        </Link>
        <Link href="/import" className={buttonClass({})}>
          Import roles
        </Link>
      </EmptyState>
    );
  }

  const selectionTargets = rows.filter((j) => selected.has(j.key));

  return (
    <div
      data-testid="triage"
      data-ready={ready ? "true" : "false"}
      // `invisible` rather than `opacity-40`: dimming with opacity is a
      // contrast failure axe reports, and it reports it on whichever machine is
      // slow enough to scan before hydration.
      className="data-[ready=false]:[&_kbd]:invisible"
    >
      <div className="mt-8">
        <h2 className="mb-1 text-xs font-medium text-muted">New roles ({rows.length})</h2>
        <ul className="border-t border-border">
          {rows.map((job, i) => {
            const facts = decisionFacts(job);
            return (
              <DecisionRow
                key={job.key}
                company={job.company}
                title={job.title}
                domain={job.companyDomain}
                facts={{
                  pay: facts.comp,
                  years: facts.minYoe,
                  place: placeLine(job),
                  age: postedAge(job.posted, today),
                }}
                mismatch={mismatchFor(job, yoeMax)}
                selected={selected.has(job.key)}
                cursor={i === safeIndex}
                busy={busy}
                showKeyHints
                onToggleSelect={(shift) => toggleSelect(job, shift)}
                onInterested={() => decideRow("interested", job)}
                onPass={() => decideRow("dismissed", job)}
                onLater={() => decideRow("snoozed", job)}
              />
            );
          })}
        </ul>
      </div>

      {/* One shortcut per line, no interpunct. The glyph used as universal glue
          between fragments is the design checklist item this footer was the
          clearest instance of; a list is what a list should be. */}
      <ul className="mt-6 space-y-0.5 text-2xs text-muted">
        <li>
          <Kbd className="ml-0">j</Kbd> <Kbd>k</Kbd> move
        </li>
        <li>
          <Kbd className="ml-0">i</Kbd> interested, <Kbd>x</Kbd> pass, <Kbd>s</Kbd> later
        </li>
        <li>
          <Kbd className="ml-0">o</Kbd> open. Every decision can be undone for 8 seconds.
        </li>
      </ul>

      {selectionTargets.length > 0 ? (
        // Fixed to the viewport and centred in it. NOT what the composition
        // literally says: it pins the bar at `left: calc(50% + 112px)`, which
        // is viewport-centre pushed right by half of the 224px rail — i.e.
        // centred over the CONTENT COLUMN, on the one desktop width a mock has.
        // That offset is wrong at every width where the rail is not 224px, and
        // below `lg` the rail is a horizontal strip and the offset would shove
        // the bar off-centre for no reason. Viewport centring is what Jobs
        // already ships for the same control, so the two surfaces agree.
        //
        // `pointer-events-none` on the positioner so the strip either side of
        // the bar does not swallow clicks on the rows underneath it.
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-10 flex justify-center px-4">
          <SelectionBar
            className="pointer-events-auto"
            count={selectionTargets.length}
            busy={busy}
            onInterested={() => submit("interested", selectionTargets, true)}
            onPass={() => submit("dismissed", selectionTargets, true)}
            onLater={() => submit("snoozed", selectionTargets, true)}
            onClear={() => {
              setSelected(new Set());
              anchorRef.current = null;
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The one optional chip (03 §9's budget), as a reason SENTENCE.
 *
 * Built by handing the gate's own token to the dictionary rather than by
 * writing the sentence here, so the phrasing on this row and the phrasing on a
 * filtered row in Jobs are the same string by construction. The shipped queue
 * wrote its own — "your limit is 4" where 02 says "your profile says 4" — and
 * `lib/dictionary.ts` records that this is the cutover where that one goes.
 *
 * Only the years mismatch. The queue also chipped a missing pay range; the
 * fact line already reads "Not listed" in the pay slot one line above, and a
 * warn chip repeating it spends the row's single chip saying nothing new.
 */
function mismatchFor(job: JobView, yoeMax: number | null): string | null {
  if (yoeMax === null || job.minYoe === null || job.minYoe <= yoeMax) return null;
  return reasonSentence(`yoe:${job.minYoe}>${yoeMax}`);
}
