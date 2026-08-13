"use client";

import { ChevronDown, ChevronRight, ListChecks, Mail } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Button, buttonClass } from "@/components/ds";
import { EmptyState } from "@/components/ds";
import { LogoAvatar } from "@/components/ds";
import { PageHeader } from "@/components/ds";
import { ExportDialog } from "@/components/export-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { appliedAge } from "@/lib/applications/age";
import { BANDS, bandOpenByDefault, bandRank, statusBand } from "@/lib/applications/bands";
import type { AppWriteResult } from "@/lib/data/source";
import type { ApplicationView } from "@/lib/data/view-models";
import type { WarmContext } from "@/lib/referral/match";
import { cn } from "@/lib/utils";
import type { WarmIntroContext } from "@/lib/warm/intro-context";
import {
  addNoteAction,
  resolveSuggestionAction,
  setNextActionAction,
  setStatusAction,
} from "./actions";
import { ApplicationPane } from "./application-pane";
import { optimisticPatch } from "./optimistic";
import { StatusSelect } from "./status-select";

/**
 * The Applications surface — the owner's composition
 * (`job-hq-design-system/project/templates/applications/Applications.dc.html`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT CHANGED AT CUTOVER, AND WHAT DID NOT
 *
 * Presentation changed: one band per STATUS became three collapsible display
 * bands, the row became the authored four-column 40px grid carrying exactly
 * three affordances, and everything else the row used to carry moved into the
 * record pane. The write path did not change by a line — same RPCs, same
 * idempotency keys, same serialized queue, same settle-on-the-server's-row rule,
 * same 0010 human-status lock. Those are the parts that lose somebody's work
 * when they are wrong, and a reskin is not a licence to touch them.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NOT VIRTUALIZED, AND THEREFORE NOT A BOUNDED FRAME
 *
 * `data-bounded-frame` is deliberately absent. It asks `AppShell` for a
 * fixed-viewport frame, which is what /jobs' virtualizer needs and what removed
 * document scrolling from twelve surfaces when it was applied globally. This
 * surface is tens of rows in a document that scrolls, so it opts out and the
 * page keeps its scrollbar — including the reserved strip that lifts the last
 * row's controls clear of a phone's toast band.
 *
 * The trigger to revisit is measured rather than guessed: `pipeline.spec.ts`
 * holds a render budget over a 200-row band, and that assertion is what will
 * say when virtualizing becomes the right call.
 *
 * Collapsed state is URL state (`?open=Active,Offers`), so back/forward works and
 * a link is shareable. So is the pane's subject (`?app=`) — which record you are
 * looking at is navigation. Display preferences are NOT in the URL: a shared
 * link must not impose the sharer's eyesight (matrix row 67, learned on /jobs).
 */

/**
 * How long one write may take before the surface stops waiting for it.
 *
 * Generous — a cold serverless function on a phone connection is genuinely slow,
 * and giving up on a write that was about to land is its own bug. The point is
 * that the bound EXISTS: the failure being prevented is not a slow save, it is a
 * surface frozen forever by a request that never answers.
 */
const WRITE_TIMEOUT_MS = 15_000;

/**
 * Reject if `p` has not settled in `ms`.
 *
 * The underlying request is not cancelled — a server action has no abort handle
 * here — so a write that lands late still lands, and its idempotency key makes
 * that safe. What the timeout buys is the CLIENT getting unstuck: the toast says
 * so, the queue drains, and the retry replays the same gesture.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type Props = {
  initial: ApplicationView[];
  /** Ambiguous-email review items, rendered above the groups. Empty is normal. */
  reviewItems?: ReviewItem[];
  /**
   * The warm-path indexes (0013), built server-side once per render.
   *
   * Optional so this component keeps working on a surface that has no universe
   * to match against; the cell is then absent rather than guessing.
   */
  warm?: WarmContext;
  /**
   * The layer-2 warm-intro context (pins lookup + the profile's default persona
   * strings), built server-side once per render. Optional for the same reason as
   * `warm`.
   */
  warmIntro?: WarmIntroContext;
};

export type ReviewItem = {
  id: string;
  /** What the classifier saw, in a person's words. */
  summary: string;
  /** Deep link to the email, when the capture recorded one. */
  evidence: string | null;
  /** The applications it could have meant — named, never guessed between. */
  candidates: { id: number; label: string }[];
};

export default function PipelineTable({ initial, reviewItems = [], warm, warmIntro }: Props) {
  const [rows, setRows] = React.useState(initial);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The server list is the starting point, re-seeded whenever a revalidation
  // delivers a new one — which is after EVERY successful write on this surface,
  // not only when another tab edits something.
  //
  // There is deliberately no "not mid-write" guard here, and an earlier comment
  // claimed `busyId` was one: it is not, it gates nothing about this effect. A
  // guard is unnecessary because the server list is authoritative by the time it
  // arrives — the write that triggered it has already settled — and a stale
  // optimistic row surviving a fresh server read is the bug the guard would cause.
  React.useEffect(() => {
    setRows(initial);
  }, [initial]);

  const openParam = searchParams.get("open");

  /**
   * Which bands are open.
   *
   * `null` (param absent) is the DEFAULT, not "none open": a bare /pipeline must
   * show live work. An explicit empty `?open=` means everything collapsed, which
   * is a state a person can reach and therefore has to be representable.
   */
  const isOpen = React.useCallback(
    (band: string): boolean => {
      if (openParam === null) return bandOpenByDefault(band);
      return openParam.split(",").filter(Boolean).includes(band);
    },
    [openParam],
  );

  const bandsPresent = React.useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) seen.add(statusBand(r.status));
    return (BANDS as readonly string[]).filter((b) => seen.has(b));
  }, [rows]);

  const toggleBand = React.useCallback(
    (band: string) => {
      const current = bandsPresent.filter(isOpen);
      const next = current.includes(band)
        ? current.filter((g) => g !== band)
        : [...current, band];
      const params = new URLSearchParams(searchParams.toString());
      // Always written explicitly, even when it matches the default. A toggle
      // that produced a bare URL would read as "default" on the way back and
      // silently re-open a band the user closed — the shape of matrix row 65 on /jobs.
      params.set("open", next.join(","));
      // `push`, not `replace`: collapsing a band is a navigation the user may
      // want to undo with Back (matrix row 120; row 53's lesson on /jobs).
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [bandsPresent, isOpen, pathname, router, searchParams],
  );

  /**
   * The pane's subject, in the URL.
   *
   * Which record you are looking at is navigation, so a link restores it and
   * Back closes the pane.
   *
   * DIGITS, anchored, before `Number` sees it — the same guard `/apply`'s route
   * uses and for the same reason: `Number("0x2")` is 2. An id that matches no
   * row renders no pane and leaves the list alone. That is not a silent guess,
   * it is the honest answer to "show me a record that is not here", and the
   * list underneath still says everything it said before.
   */
  const selectedId = React.useMemo(() => {
    const raw = searchParams.get("app");
    if (!raw || !/^[0-9]+$/.test(raw)) return null;
    return Number(raw);
  }, [searchParams]);

  /**
   * OPENING pushes; MOVING between rows replaces.
   *
   * Opening the pane is a navigation a person expects Back to undo, so it earns
   * a history entry. Moving the pane from one row to the next is not: pushing
   * there buries the list behind one entry per row you glanced at, so Back walks
   * backwards through a reading session instead of closing the pane. With
   * `replace`, Back means "close this" however many rows you looked at first.
   *
   * `/jobs` pushes on both, and this deliberately does not follow it. The
   * difference is asserted rather than argued: `pipeline.spec.ts` walks three
   * rows and presses Back once.
   */
  /**
   * Where focus goes when the pane closes.
   *
   * ════════════════════════════════════════════════════════════════════════════
   * RESTORING IT IS THE CALLER'S JOB, AND THIS BRANCH FORGOT ONCE
   *
   * The pane is not a dialog, so nothing restores focus for it — Radix does that
   * for a modal and there is no modal here. `onClose` used to just clear the URL,
   * which drops focus to `document.body`: open the pane from row 40, close it,
   * and a keyboard user is at the TOP of the document with forty rows to tab
   * back through. `docs/WEBAPP-BUILD.md` row 119 has claimed "Escape closes and
   * focus returns to the trigger that opened it" since the notes dialog, and
   * deleting that dialog without carrying the behaviour over turned the row into
   * a false green — the same defect this branch diagnosed in the Loading cell.
   *
   * The subject id is remembered rather than a DOM node: the row can re-render
   * (a write settles, a revalidation lands) between opening and closing, so a
   * captured element may be detached by the time it is needed. An id survives
   * that; the query runs against whatever is on screen NOW.
   */
  const restoreFocusTo = React.useRef<number | null>(null);

  const setSelected = React.useCallback(
    (id: number | null) => {
      const params = new URLSearchParams(searchParams.toString());
      const wasOpen = params.get("app") !== null;
      if (id === null) params.delete("app");
      else {
        params.set("app", String(id));
        // Remembered on the way IN. On the way out there is nothing left to read
        // it from, and the row that opened the pane is not always the row the
        // pane ended on.
        if (!wasOpen) restoreFocusTo.current = id;
      }
      const query = params.toString();
      const url = query ? `${pathname}?${query}` : pathname;
      // Closing pushes too: it is the undo of an entry that was pushed, and a
      // replace there would leave Back re-opening the pane the user just closed.
      if (wasOpen && id !== null) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  /**
   * The freshest rows, readable from inside an async write.
   *
   * A closure that captured `rows` would send the version token as it was when
   * the gesture STARTED, which is wrong the moment two writes land in sequence:
   * the second carries a token the first already superseded and conflicts against
   * a write the same user just made.
   *
   * **Written synchronously, not from an effect**, and that is the fix for a real
   * bug rather than a style preference. An effect runs after paint — a MACROTASK —
   * while this queue advances on promise callbacks, which are MICROTASKS. So write
   * B read `rowsRef.current` before React had re-rendered from write A's result,
   * got the pre-A token, and conflicted: text-blur then date-blur lost the date
   * and raised a spurious "Changed on another device" toast, on both projects,
   * with no added latency at all. The ref is a cache of the latest known rows, so
   * the moment we know them is the moment to write it.
   */
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;

  /** Replace one row, by id. Used by both the optimistic write and its revert. */
  const put = React.useCallback((next: ApplicationView) => {
    // Both, in this order. The ref is what the NEXT queued write reads, and it
    // cannot wait for a render.
    rowsRef.current = rowsRef.current.map((r) => (r.id === next.id ? next : r));
    setRows(rowsRef.current);
  }, []);

  /**
   * Writes run one at a time, in the order they were made.
   *
   * The first version simply DROPPED a gesture that arrived while another was in
   * flight (`if (busyId !== null) return`), and that is how a real bug shipped:
   * the next-action fields commit on blur, so typing text and then tabbing to
   * the date produces two writes milliseconds apart, and the second silently
   * vanished. It passed on a desktop run and failed on the phone one — timing
   * luck, on a path whose whole job is not losing what somebody typed.
   *
   * Serializing keeps every gesture, in order, and each one reads its version
   * token when its turn comes rather than when it was queued.
   */
  const tail = React.useRef<Promise<unknown>>(Promise.resolve());

  /**
   * How many writes are queued or in flight, published to the DOM.
   *
   * Two reasons, and the second is why it is an attribute rather than a ref:
   *
   *   * A person editing a blur-committed field has no other signal that
   *     anything is happening. "Saving…" is the smallest honest one.
   *   * A reload cancels an in-flight server action, so a test that fills a
   *     field and reloads immediately loses the write — and would have reported
   *     it as a persistence bug. This is the `data-ready` pattern the queue
   *     already uses (docs/WEBAPP-BUILD.md row 21): the surface says when it is
   *     quiet, and tests wait on that instead of racing it with a sleep.
   */
  const [pending, setPending] = React.useState(0);

  /**
   * False in the server HTML, true only after an effect runs — which is the
   * definition of "hydration finished and handlers are attached". The trace
   * that finally cracked the durability flake showed both blur gestures firing
   * 95ms after load into a server-rendered-but-unhydrated form: locators
   * resolve, fill sets DOM values, and NOTHING is listening — zero POSTs in
   * the whole trace. Tests gate on this attribute before the first gesture
   * (docs/WEBAPP-BUILD.md row 21's pattern); a real fast-fingered user on a
   * slow device hits the same gap, which is why the marker is honest surface
   * state, not test scaffolding.
   */
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  /**
   * How many writes have FINISHED — monotonic, and the thing a test can wait on.
   *
   * `pending === 0` looks like the obvious signal and is unsound: it is true both
   * BEFORE a write starts and after it ends, so a check that runs in the window
   * between a blur and its commit sees "quiet", reloads, and cancels the write it
   * was waiting for. That produced a failure indistinguishable from a real
   * persistence bug, on the one surface whose job is not losing what was typed.
   *
   * A count that only goes up has no such window: read it, act, wait for it to
   * pass. It counts every outcome, not just successes — a write that conflicted
   * is finished too, and a counter that skipped those would hang.
   */
  const [writes, setWrites] = React.useState(0);

  /**
   * Where focus goes when the queue settles — the busy disable's missing half
   * (#232, FP-DES-007).
   *
   * ════════════════════════════════════════════════════════════════════════════
   * THE DEFECT, MEASURED
   *
   * Every status trigger is `disabled={anyBusy}` while a write is in flight, and
   * the browser drops focus from a disabled control. So EVERY status write —
   * success or failure — landed keyboard focus on `document.body`, exactly the
   * stranding the pane, the withdraw dialog, and the custom-status field each
   * fixed for themselves. #199's probe measured it on a plain successful write.
   *
   * The capture lives here, at the one choke point every write on this surface
   * goes through, for the same reason the withdraw gate does: a control added
   * later is covered without knowing this exists.
   *
   * ════════════════════════════════════════════════════════════════════════════
   * THE SUCCESSOR RULE
   *
   * On settle, focus returns to the first of these that still exists and is
   * enabled — and never to `<body>`:
   *
   *   1. the exact element that held focus when the write was made;
   *   2. the record's status control where it now renders — the open pane's
   *      first, else the row's, which after a band move is a NEW node the old
   *      capture cannot reach (the row remounts under another band's list);
   *   3. the toggle of the band that now holds the record — when the write
   *      moved the row into a collapsed band, that toggle is the one control
   *      that can reveal it again;
   *   4. the first band toggle on the surface, when the record left the list
   *      entirely (a revalidation dropped it).
   *
   * And it never STEALS: if settle finds focus already somewhere real — the
   * pane's close button after Confirm/Dismiss hand it there, a field the user
   * moved to during the write — the restoration stands down. That guard is what
   * lets the capture arm on every write, next-action blurs included, without
   * yanking focus from someone mid-type.
   *
   * An element plus the row id, not a DOM node alone: the element answers "is
   * the trigger still there", the id is what the successor steps query by after
   * a re-render has replaced every node the gesture touched.
   */
  const settleFocus = React.useRef<{ el: HTMLElement; id: number } | null>(null);

  /**
   * Every write on this surface, in one place.
   *
   * The four branches are the substance, and a second copy of them is a second
   * place for one to rot (the same reasoning `triage-queue.tsx` records for
   * `undoDelivered`):
   *
   *   ok       — settle on the row the SERVER returned, never the optimistic one.
   *              Keeping ours leaves the client holding a version token the
   *              server has already moved past, and the next gesture conflicts
   *              against a write we made ourselves.
   *   conflict — settle on `result.current` and say so. A toast alone leaves the
   *              stale value on screen, which is matrix row 113: the user is told
   *              something changed and shown the thing that did not.
   *   auth     — revert and say the session expired. Nothing queues or replays
   *              a pipeline gesture (DEC-011 — the rule every surface now
   *              follows, since #222 removed the queue's outbox), so offering
   *              "saved on this device" for a write that is not held anywhere
   *              would be a lie about durability.
   *   error    — revert and offer Retry.
   */
  const write = React.useCallback(
    (
      id: number,
      optimistic: Partial<ApplicationView>,
      /** Receives the row as it is when this write's turn comes, tokens included. */
      send: (before: ApplicationView) => Promise<AppWriteResult>,
      onRetry: () => void,
    ): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const before = rowsRef.current.find((r) => r.id === id);
        // The row left while this was queued — a revalidation dropped it, or the
        // posting was un-triaged. Nothing to write, and nothing to apologise for.
        if (!before) return false;

        setBusyId(id);
        put({ ...before, ...optimistic });

        let result: AppWriteResult;
        try {
          // Every external call gets a bound — the house rule that already cost
          // three outages in one day. Without it a hung server action strands
          // "Saving…" forever AND leaves `anyBusy` disabling every control on the
          // surface, so the whole pipeline is frozen by one request that will
          // never answer. Verified: exactly one POST was ever made, and a second
          // gesture never reached the network.
          result = await withTimeout(send(before), WRITE_TIMEOUT_MS);
        } catch {
          put(before);
          setBusyId(null);
          toast.error("Couldn't save that. The server did not answer.", {
            action: { label: "Retry", onClick: onRetry },
          });
          return false;
        }
        setBusyId(null);

        if (result.ok) {
          put(result.application);
          return true;
        }
        if (result.kind === "conflict") {
          put(result.current);
          toast.warning("This row changed since you loaded it. Review the latest version before saving.");
          return false;
        }
        put(before);
        if (result.kind === "auth") {
          toast.error("Couldn't save that. Your session expired.", {
            description: "Sign in and try again.",
          });
        } else {
          toast.error("Couldn't save that.", {
            description: result.message,
            action: { label: "Retry", onClick: onRetry },
          });
        }
        return false;
      };

      // Captured at GESTURE time, synchronously: one render later the busy
      // disable has already dropped focus to <body> and there is nothing left
      // to read. The last gesture wins — the queue serializes writes, and the
      // control focus belongs back on is the one the person touched last. A
      // gesture that held no focus (a commit fired by clicking empty space)
      // DISARMS instead: the write took focus from nobody, so settling it must
      // hand focus to nobody.
      const active = document.activeElement;
      settleFocus.current =
        active instanceof HTMLElement && active !== document.body ? { el: active, id } : null;

      setPending((n) => n + 1);
      const settle = async () => {
        try {
          return await run();
        } finally {
          setPending((n) => Math.max(0, n - 1));
          setWrites((n) => n + 1);
        }
      };
      // Chained on both settle paths, so one rejection cannot wedge the queue.
      const next = tail.current.then(settle, settle);
      tail.current = next.catch(() => undefined);
      return next;
    },
    [put],
  );

  const changeStatus = React.useCallback(
    (app: ApplicationView, status: string, note?: string, idem = crypto.randomUUID()) =>
      write(
        app.id,
        optimisticPatch(app, { kind: "status", status }),
        (before) =>
          setStatusAction({
            applicationId: before.id,
            status,
            note: note ?? null,
            idempotencyKey: idem,
            expectedUpdatedAt: before.updatedAt,
          }),
        // The SAME key on retry. Minting a fresh one made every retry a second
        // command rather than a replay, so a request whose RESPONSE was lost —
        // the timeout above, a dropped connection, a deploy mid-flight — applied
        // twice against a trail that cannot be de-duplicated afterwards. That is
        // matrix row 10's whole claim, and it was not true on this surface.
        () => void changeStatus(app, status, note, idem),
      ),
    [write],
  );

  const resolve = React.useCallback(
    (app: ApplicationView, decision: "confirm" | "reject", idem = crypto.randomUUID()) =>
      write(
        app.id,
        // The frame this paints is pinned in tests/unit/optimistic.test.ts, which
        // is the only place it can be: the demo store answers faster than
        // Playwright can look, so a reject that optimistically applied the
        // declined status passed every E2E in the suite.
        optimisticPatch(app, { kind: decision }),
        (before) =>
          resolveSuggestionAction({
            applicationId: before.id,
            decision,
            idempotencyKey: idem,
            expectedUpdatedAt: before.updatedAt,
          }),
        () => void resolve(app, decision, idem),
      ),
    [write],
  );

  const addNote = React.useCallback(
    (app: ApplicationView, body: string, idem = crypto.randomUUID()) =>
      write(
        app.id,
        optimisticPatch(app, { kind: "note" }),
        (before) =>
          addNoteAction({
            applicationId: before.id,
            body,
            idempotencyKey: idem,
          }),
        () => void addNote(app, body, idem),
      ),
    [write],
  );

  /**
   * Withdrawing asks first — from EVERY control, not just the one that asks.
   *
   * ════════════════════════════════════════════════════════════════════════════
   * WHY THE GATE IS ON THE WRITE AND NOT ON A BUTTON
   *
   * The pane grew a Withdraw button with 02 §7's confirmation, and the
   * confirmation was theatre: `selectableStatuses` includes every terminal
   * status, so "Withdrawn" is an ordinary option in the row's status select and
   * in the pane's, and picking it there produced the identical write with no
   * confirmation at all. A review round picked it straight off the row and the
   * write landed. A confirmation covering one of two paths to the same write is
   * not a confirmation, it is a speed bump on the polite route.
   *
   * So the gate sits on the DESTINATION STATUS at the single place every status
   * write on this surface goes through. Every control — the row select, the
   * pane select, the pane's button, a custom status somebody typed by hand —
   * reaches it, and a control added later reaches it without knowing it exists.
   *
   * Withdrawn is the only status gated, and that is deliberate rather than
   * timid: it is the one whose consequence is not visible in the word. Rejected
   * is a fact being recorded, Offer is good news; Withdrawn STOPS REMINDERS,
   * which is a thing the app will now not do for you, and 02 §7 requires saying
   * so before it happens.
   *
   * A row already Withdrawn is not re-gated: re-picking the status it already
   * has is a no-op the server short-circuits, and asking about it would be a
   * confirmation for nothing.
   *
   * ════════════════════════════════════════════════════════════════════════════
   * ONE ROUTE IS NOT COVERED, AND SAYING SO IS THE POINT
   *
   * Confirming a suggestion does not come through here. `resolveSuggestionAction`
   * applies whatever the server holds in `suggested_status`, so a suggestion of
   * `Withdrawn` would land without this confirmation. The gate covers every
   * route a PERSON can choose a status by; it does not cover accepting a status
   * something else chose.
   *
   * Not reachable today: Gmail ingestion is the pilot's sole product exclusion
   * and nothing writes `suggested_status` in this build, so no suggestion of any
   * value exists to confirm. It is written down rather than left to be
   * discovered, because "every route" was the claim and this is one short of it.
   * When a producer for that column ships, either `app_resolve_suggestion` gates
   * the terminal case in SQL or this surface confirms before resolving — and
   * that is a decision for the packet that turns the producer on, not one to
   * make here against a column nothing fills.
   */
  const [pendingWithdraw, setPendingWithdraw] = React.useState<ApplicationView | null>(null);

  /**
   * Who asked, so focus can go back to them.
   *
   * This dialog is CONTROLLED — it has no `DialogTrigger`, because three
   * different controls open it — so Radix has nothing to restore focus to and
   * drops it on `document.body` when it closes. Measured: after Escape, focus
   * was outside the pane entirely and the pane's own Escape stopped working,
   * which is the same stranding the inline confirmation caused and the reason
   * that confirmation was replaced.
   *
   * Captured at REQUEST time, before Radix moves focus into the dialog.
   */
  const withdrawAskedBy = React.useRef<HTMLElement | null>(null);

  const requestStatus = React.useCallback(
    (app: ApplicationView, status: string) => {
      if (status === "Withdrawn" && app.status !== "Withdrawn") {
        const active = document.activeElement;
        withdrawAskedBy.current = active instanceof HTMLElement ? active : null;
        setPendingWithdraw(app);
        return;
      }
      void changeStatus(app, status);
    },
    [changeStatus],
  );

  /**
   * Hand focus back once the dialog is gone.
   *
   * In an effect rather than in the close handler, for the pane's reason: it has
   * to run after the dialog has unmounted, or Radix's own close-autofocus takes
   * it back. `isConnected` because the row can re-render while the dialog is
   * open — a write settling, a revalidation landing — and focusing a detached
   * node silently does nothing, which would look like the defect this fixes.
   */
  React.useEffect(() => {
    if (pendingWithdraw !== null) return;
    const el = withdrawAskedBy.current;
    if (!el) return;
    withdrawAskedBy.current = null;
    if (el.isConnected) el.focus();
  }, [pendingWithdraw]);

  const saveNextAction = React.useCallback(
    (app: ApplicationView, text: string, date: string | null, idem = crypto.randomUUID()) =>
      write(
        app.id,
        optimisticPatch(app, { kind: "next-action", text, date }),
        (before) =>
          setNextActionAction({
            applicationId: before.id,
            nextAction: text,
            nextActionDate: date,
            idempotencyKey: idem,
            expectedUpdatedAt: before.updatedAt,
          }),
        () => void saveNextAction(app, text, date, idem),
      ),
    [write],
  );

  /**
   * The bands, each with its rows.
   *
   * Hand-built rather than through `@tanstack/react-table`'s grouped row model,
   * which is what this used before. Three fixed buckets over tens of rows do not
   * need a table engine, and the engine's presence cost a real thing: its
   * accessor keyed the group on the STATUS STRING, so band order had to be
   * recovered afterwards by rank anyway.
   */
  const bands = React.useMemo(() => {
    const byBand = new Map<string, ApplicationView[]>();
    for (const r of rows) {
      const band = statusBand(r.status);
      const list = byBand.get(band);
      if (list) list.push(r);
      else byBand.set(band, [r]);
    }
    return [...byBand.entries()]
      .sort((a, b) => bandRank(a[0]) - bandRank(b[0]))
      .map(
        ([band, items]) =>
          [
            band,
            // Ordered by id, NOT by `updatedAt`.
            //
            // Sorting by recency read as "keep what you just touched near the
            // top" and does the opposite of what it says: every edit moves the
            // row you are working on, under your own cursor, and the next row
            // you wanted is somewhere else. `updatedAt` also moves for writes a
            // person did not make (a bot advancing a status), so the list
            // reshuffles on its own.
            //
            // A stable key means the row stays put while you edit it, which is
            // the property a list you EDIT needs — the opposite trade from the
            // queue, which is a working set you walk once.
            [...items].sort((a, b) => a.id - b.id),
          ] as const,
      );
  }, [rows]);

  const selected = React.useMemo(
    () => (selectedId === null ? null : (rows.find((r) => r.id === selectedId) ?? null)),
    [rows, selectedId],
  );

  /**
   * Put focus back on the control that opened the pane, once it is gone.
   *
   * In an effect keyed on `selectedId`, so it runs AFTER the pane has unmounted
   * and the row list has re-rendered — focusing before that races the element
   * out from under itself. It fires only on the closing transition, never on a
   * row-to-row move, and it does nothing if the row has since left the list
   * (withdrawn into a collapsed band, dropped by a revalidation): moving focus
   * to a row that is not there is worse than leaving it where it is.
   */
  React.useEffect(() => {
    if (selectedId !== null) return;
    const id = restoreFocusTo.current;
    if (id === null) return;
    restoreFocusTo.current = null;
    const trigger = document.querySelector<HTMLElement>(`[data-testid="open-${id}"]`);
    trigger?.focus();
  }, [selectedId]);

  const anyBusy = busyId !== null;

  /**
   * The restoration itself — `settleFocus`'s comment carries the rule.
   *
   * In an effect keyed on the busy state, and that sequencing is the second
   * half of #232's attack list: focusing a control that is still `disabled` is
   * SILENTLY lost, so calling `.focus()` inside the write path — after
   * `setBusyId(null)` but before React commits the render that removes the
   * attribute — restores nothing and looks like it did. An effect cannot run
   * early like that: React commits the re-enabled DOM first, then runs this.
   *
   * Gated on the QUEUE being quiet, not just `busyId`: between two queued
   * writes `busyId` clears for a render while `pending` — incremented
   * synchronously at gesture time — still covers the write whose turn is next,
   * so a mid-queue quiet window cannot fire a premature restore.
   */
  React.useEffect(() => {
    if (anyBusy || pending > 0) return;
    const target = settleFocus.current;
    if (target === null) return;
    settleFocus.current = null;
    // Never steal. If focus is already somewhere real, someone put it there —
    // the pane's Confirm/Dismiss handing it to Close, a person typing in a
    // field the busy window never disabled — and this effect stands down.
    const held = document.activeElement;
    if (held instanceof HTMLElement && held !== document.body) return;
    const usable = (el: HTMLElement | null): HTMLElement | null =>
      el !== null && el.isConnected && !el.matches(":disabled") ? el : null;
    const find = (selector: string) => usable(document.querySelector<HTMLElement>(selector));
    const row = rowsRef.current.find((r) => r.id === target.id);
    const next =
      usable(target.el) ??
      find(
        `[data-testid="application-pane"][data-application="${target.id}"]` +
          ` [data-testid="status-trigger-${target.id}"]`,
      ) ??
      find(`[data-testid="status-trigger-${target.id}"]`) ??
      (row === undefined ? null : find(`[data-testid="group-toggle-${statusBand(row.status)}"]`)) ??
      find(`[data-testid^="group-toggle-"]`);
    next?.focus();
  }, [anyBusy, pending]);

  /** Rows that are still live: everything the Closed band does not hold. */
  const inFlight = React.useMemo(
    () => rows.filter((r) => statusBand(r.status) !== "Closed").length,
    [rows],
  );

  return (
    <div
      /* `items-stretch`, so the pane's left border runs the full height of the
         list beside it — the authored `display:flex;align-items:stretch`. NOT a
         bounded frame: see the module comment. */
      className="flex min-w-0 flex-col items-stretch lg:flex-row"
      data-testid="pipeline"
      data-saving={pending > 0 ? "true" : "false"}
      data-hydrated={hydrated ? "true" : "false"}
      data-writes={writes}
    >
      <div className="min-w-0 flex-1 p-4 md:p-6">
        <PageHeader
          title="Applications"
          // A subtitle only when it carries operating information — and it has
          // to be TRUE. `rows.length` counted every row, so a withdrawn and a
          // rejected application were both reported as "in flight", which is
          // the one thing that phrase promises they are not. Closed is the band
          // that means ended; everything else is live work, an offer included,
          // because an offer you have not answered is still in flight.
          subtitle={`${inFlight} in flight`}
          action={<ExportDialog dataset="applications" />}
        />

        {/* `aria-live` so a screen-reader user gets the same signal a sighted
            one does. Removed from the DOM when idle rather than emptied, so it
            does not take up a line in the layout. */}
        {pending > 0 ? (
          <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
            Saving
          </p>
        ) : null}

        {reviewItems.length > 0 ? <NeedsReview items={reviewItems} /> : null}

        {rows.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="Applications you submit will be tracked here."
            // NOT the template's "including status changes read from your email".
            // Gmail ingestion is the pilot's one product exclusion, so that
            // sentence would promise a capability this build does not have. What
            // is stated is the half that is wired.
            description="A role you mark interesting becomes a row here. Status is yours to set; nothing changes it behind your back."
          >
            <Link href="/queue" className={buttonClass({ variant: "primary" })}>
              Review the roles waiting for you
            </Link>
          </EmptyState>
        ) : null}

        {bands.map(([band, items]) => {
          const open = isOpen(band);
          return (
            <section key={band} data-testid={`group-${band}`} className="mt-6 first:mt-4">
              <h2>
                <button
                  type="button"
                  onClick={() => toggleBand(band)}
                  aria-expanded={open}
                  data-testid={`group-toggle-${band}`}
                  // `min-h-6` for SC 2.5.8: the band header was a 16px-tall
                  // target, which is the height of its own text. Collapsing a
                  // band is the one gesture on this surface that hides rows, so
                  // a miss is a person losing sight of their own applications.
                  className="inline-flex min-h-6 items-center gap-2 rounded-md text-left text-xs
                             font-medium text-muted hover:text-text-2 focus-visible:outline-2
                             focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {open ? (
                    <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                  {/* The count is INSIDE the band name's line and is tabular, so
                      a band that gains a row does not shift the chevron. */}
                  <span className="tabular min-w-0 break-words">
                    {band} ({items.length})
                  </span>
                </button>
              </h2>

              {open ? (
                <ul
                  className="mt-2 divide-y divide-border overflow-hidden rounded-lg border
                             border-border bg-surface"
                >
                  {items.map((app) => (
                    <ApplicationRow
                      key={app.id}
                      app={app}
                      busy={busyId === app.id}
                      anyBusy={anyBusy}
                      selected={selectedId === app.id}
                      onOpen={() => setSelected(app.id)}
                      onStatus={(s) => requestStatus(app, s)}
                      onNextAction={(t, d) => void saveNextAction(app, t, d)}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}

        {/* The safe area is the toast-strip lesson (matrix row 100): on a phone a
            confirmation toast occupies a fixed band at the bottom of the viewport,
            and a document exactly viewport-height leaves the last row's controls
            under it with nowhere to scroll clear. Reserving space below the list
            means the page always scrolls far enough to lift them out of the strip.
            NOT claimed: that a bottom-anchored toast never overlaps anything. */}
        <div aria-hidden="true" data-testid="toast-safe-area" className="h-40" />
      </div>

      {/* One confirmation, for every route to the same write. A Radix dialog
          rather than an inline panel: it restores focus to whatever opened it
          when it closes, which an inline panel that swaps itself out cannot do —
          that exact swap stranded a keyboard user in the version this replaces. */}
      <Dialog
        open={pendingWithdraw !== null}
        onOpenChange={(next) => {
          if (!next) setPendingWithdraw(null);
        }}
      >
        {pendingWithdraw ? (
          <DialogContent
            // Singular, and a deliberate departure from 02 §7's literal string
            // ("Withdraw 1 application? Their status becomes Withdrawn…"). That
            // template is a BULK pattern with n substituted — "Their" for one
            // application is the giveaway — and this surface has no bulk
            // withdraw to justify it. Recorded as DEV-006.
            title="Withdraw this application?"
            description={`${pendingWithdraw.company}, ${pendingWithdraw.title}`}
          >
            <p data-testid="withdraw-consequence" className="text-sm text-text">
              Its status becomes Withdrawn and reminders stop.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                data-testid="withdraw-keep"
                onClick={() => setPendingWithdraw(null)}
              >
                Keep
              </Button>
              <Button
                data-testid="withdraw-confirm"
                onClick={() => {
                  const target = pendingWithdraw;
                  setPendingWithdraw(null);
                  void changeStatus(target, "Withdrawn");
                }}
              >
                Withdraw
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      {selected ? (
        <ApplicationPane
          // Keyed by subject, so moving between rows REMOUNTS the pane. That is
          // the point rather than a side effect: the notes history, the composer
          // draft and the reopen reason all belong to ONE application, and
          // carrying any of them into another row's pane is the worst thing this
          // component could do with them. The pane's focus-on-appear effect is
          // written against this policy — see its comment.
          key={selected.id}
          app={selected}
          anyBusy={anyBusy}
          warm={warm}
          warmIntro={warmIntro}
          onClose={() => setSelected(null)}
          onStatus={(s) => requestStatus(selected, s)}
          onReopen={(note) => void changeStatus(selected, "Applied", note)}
          onResolve={(d) => void resolve(selected, d)}
          onAddNote={(body) => addNote(selected, body)}
        />
      ) : null}
    </div>
  );
}

/**
 * One application row — the authored four-column grid.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EXACTLY THREE AFFORDANCES
 *
 * Identity, status, next action. The row this replaces carried seven, and the
 * extra four were not free: a seventh control at 375px is what painted past the
 * page edge, and a list you have to read before you can scan is not a list. All
 * of them still exist — the delisted marker, the evidence link, the notes
 * history, Prepare and the two warm affordances live in the pane now, which is
 * what a row click opens.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE ROW IS NOT A BUTTON
 *
 * Two of the three affordances are themselves interactive (a Select and two
 * inputs), so wrapping the row in a `<button>` would nest interactive content
 * inside interactive content — invalid, and a keyboard user would find one stop
 * where there are three controls. The row is a list item with a click handler
 * for the pointer, plus its own separate "Open details" control for keyboard and
 * assistive tech. That control is the accessible affordance; the row click is a
 * convenience layered on top of it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE GRID, AND THE ONE PLACE IT DEPARTS FROM THE TEMPLATE
 *
 * `minmax(220px,1fr) 130px 150px minmax(190px,280px)` is the authored track
 * list, and its minimum total is 690px. A 375px phone cannot hold it, and the
 * template authors no phone frame for this surface — so the grid applies from
 * `md` up and the row stacks below it, which is what the shipped surface already
 * did at that width. That is preserved behavior rather than invented UI; the
 * phone composition is named as a design gap in the PR.
 */
/**
 * De-emphasised text on a row, at a contrast that survives being selected.
 *
 * `--selected` is a TINT, not a neutral, and `--muted` on it measures 3.97:1 —
 * below AA, reported by axe on this branch before this existed. De-emphasis is
 * never a licence to drop below AA, and the row you are looking at is the one
 * you most need to read.
 *
 * One function rather than the ternary written out at each site: the row has
 * three muted slots today and the fourth one somebody adds is the one that would
 * have been written the old way. `pipeline.spec.ts`'s axe scan opens the pane —
 * which is what selects a row — so a slot that forgets this goes red rather
 * than shipping.
 */
const MUTED_ON_ROW = (selected: boolean, slot: "text" | "placeholder" = "text") => {
  // LITERAL class strings, never assembled from a prefix. Tailwind scans source
  // for whole class names, so `${prefix}text-muted` produces a class the build
  // has never heard of and the style silently does not exist — a fix that
  // compiles, type-checks, and changes nothing on screen. Four strings written
  // out is the price of the scanner being able to see them.
  if (slot === "placeholder") {
    return selected ? "placeholder:text-text-2" : "placeholder:text-muted";
  }
  return selected ? "text-text-2" : "text-muted";
};

function ApplicationRow({
  app,
  busy,
  anyBusy,
  selected,
  onOpen,
  onStatus,
  onNextAction,
}: {
  app: ApplicationView;
  busy: boolean;
  anyBusy: boolean;
  selected: boolean;
  onOpen: () => void;
  onStatus: (status: string) => void;
  onNextAction: (text: string, date: string | null) => void;
}) {
  return (
    <li
      data-testid={`row-${app.id}`}
      data-busy={busy ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      onClick={(e) => {
        // Only a click on the row's own chrome opens the pane. A click that
        // landed on the status pill, an input, or a link belongs to that
        // control — opening the pane underneath it would move focus out from
        // under a gesture already in progress.
        if ((e.target as HTMLElement).closest("button,a,input,select,textarea,[role='listbox']")) {
          return;
        }
        onOpen();
      }}
      className={cn(
        /* `hq-row` rather than a fixed height: the density knob is an <html>
           attribute, so it has to reach rows this component does not re-render.
           The authored 40px is the compact value that knob already resolves. */
        "hq-row grid grid-cols-1 items-center gap-x-2 gap-y-1 px-2",
        "md:grid-cols-[minmax(220px,1fr)_130px_150px_minmax(190px,280px)]",
        selected ? "bg-selected" : "hover:bg-raised",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 px-2">
        <LogoAvatar name={app.company} size={16} />
        {/* The keyboard's way in. It names the record it opens, and the title
            sits beside it as ordinary text — two links per row is two tab stops
            for one destination.

            `aria-label` rather than an `sr-only` span, and that is a fix for a
            measured break rather than a preference: `sr-only` is clipped, not
            hidden, so it stays in `innerText`. `import.spec.ts` reads the row's
            first line to learn the company name for a round-trip file, and an
            sr-only prefix made every such read return "Open details for Stripe".
            A visually hidden string that lands in a text read is a string that
            will end up in somebody's spreadsheet. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open details for ${app.company}`}
          data-testid={`open-${app.id}`}
          // `min-h-6` for SC 2.5.8. The row is 40px tall at the default density
          // and 32 at compact, so a 24px target sits inside it either way — the
          // constraint costs nothing here and the control was 20px tall.
          className="inline-flex min-h-6 min-w-0 shrink-0 items-center rounded-md text-left
                     font-medium text-text focus-visible:outline-2 focus-visible:outline-offset-2
                     focus-visible:outline-ring"
        >
          {app.company}
        </button>
        <span className="min-w-0 truncate text-text-2">{app.title}</span>
        {/* Delisted is a fact about the POSTING, and it is deliberately NOT on
            the row: the authored row has four cells and none of them is a
            badge, and the affordance budget is three. It reads as a sentence
            in the pane instead ("The board no longer lists this posting. The
            application is unaffected."), which is where a fact that needs a
            sentence belongs.

            The badge that briefly lived here also tripped the anti-slop sweep
            on its own merits: `Badge` is `rounded-full`, and a pill on a 40px
            row is the radius rule's exact target. */}
      </span>

      <span
        data-testid={`applied-age-${app.id}`}
        className={cn(
          "tabular whitespace-nowrap px-2 text-xs md:text-right",
          MUTED_ON_ROW(selected),
        )}
      >
        {appliedAge(app.appliedDate)}
      </span>

      <span className="min-w-0 px-1">
        <StatusSelect
          applicationId={app.id}
          status={app.status}
          disabled={anyBusy}
          onSelect={onStatus}
        />
      </span>

      <span className="min-w-0 px-1">
        <NextActionCell app={app} selected={selected} onSave={onNextAction} />
      </span>
    </li>
  );
}


/** Next action + date, saved on blur. */
/**
 * These two inputs are deliberately NOT disabled while a write is in flight.
 *
 * `disabled` on a focused input makes the browser blur it, which is how a
 * half-typed value disappears while its own commit is still queued. Writes are
 * serialized instead, so a second gesture waits its turn rather than being
 * dropped or racing.
 */
function NextActionCell({
  app,
  selected,
  onSave,
}: {
  app: ApplicationView;
  /** Whether the owning row is selected; see `MUTED_ON_ROW`. */
  selected: boolean;
  onSave: (text: string, date: string | null) => void;
}) {
  const [text, setText] = React.useState(app.nextAction ?? "");
  const [date, setDate] = React.useState(app.nextActionDate ?? "");

  /**
   * The commit reads THESE, never the state above. Five CI failures established
   * that the second of two blur-commits can vanish: under mobile-emulation
   * scheduling the blur handler can run before React commits the onChange
   * state, the no-op guard below then compares the OLD value, reads
   * "unchanged", and drops the gesture with no trace. It survived a poll-budget
   * fix, suite sharding, and a 120s test budget, and never reproduced under a
   * 20x page-CPU throttle — the race needs an event-loop interleaving, not
   * slowness. A ref written synchronously in the onChange handler cannot lag
   * the blur, whatever the scheduler does. State keeps driving the render.
   */
  const pendingText = React.useRef(app.nextAction ?? "");
  const pendingDate = React.useRef(app.nextActionDate ?? "");

  /**
   * Re-seeded when the server row changes — a conflict refresh has to be visible
   * in the inputs too, or the screen keeps showing the value that lost.
   *
   * TWO effects, one per field, and that is the fix for a real bug rather than
   * tidiness. Both fields in one effect meant the text write landing re-seeded
   * the DATE as well, from a server row that did not have it yet — so a person
   * who typed text, tabbed to the date and typed that watched the date clear
   * itself the moment the first write returned. Keyed per field, the date's
   * effect does not run at all when only the text changed.
   */
  React.useEffect(() => {
    setText(app.nextAction ?? "");
    pendingText.current = app.nextAction ?? "";
  }, [app.nextAction]);
  React.useEffect(() => {
    setDate(app.nextActionDate ?? "");
    pendingDate.current = app.nextActionDate ?? "";
  }, [app.nextActionDate]);

  const commit = () => {
    const t = pendingText.current.trim();
    const d = pendingDate.current || null;
    // The action is idempotent and the server short-circuits a no-op, but not
    // sending at all is cheaper than both and keeps the audit trail clean.
    if (t === (app.nextAction ?? "") && d === (app.nextActionDate ?? null)) return;
    onSave(t, d);
  };

  return (
    /* The authored cell: one bordered box that only shows its border on hover or
       focus, holding the text and its date. `flex-wrap` under `md` because the
       stacked phone row has no 190px track to hold both on one line. */
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-transparent
                 px-2 hover:border-border-strong md:flex-nowrap"
    >
      <label className="sr-only" htmlFor={`next-action-${app.id}`}>
        Next action for {app.company}
      </label>
      <input
        id={`next-action-${app.id}`}
        data-testid={`next-action-${app.id}`}
        value={text}
        onChange={(e) => { pendingText.current = e.target.value; setText(e.target.value); }}
        onBlur={commit}
        maxLength={500}
        placeholder="Add next action"
        className={cn(
          `min-w-0 flex-1 truncate border-none bg-transparent py-1 text-sm text-text outline-none
           focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring`,
          // Through the same helper as every other muted slot on the row. A
          // hand-rolled ternary here is precisely the shape `MUTED_ON_ROW`
          // exists to stop — it was written that way once and the review
          // caught it — so the placeholder variant lives in the helper too.
          MUTED_ON_ROW(selected, "placeholder"),
        )}
      />
      <label className="sr-only" htmlFor={`next-action-date-${app.id}`}>
        Next action date for {app.company}
      </label>
      <input
        id={`next-action-date-${app.id}`}
        data-testid={`next-action-date-${app.id}`}
        type="date"
        value={date}
        onChange={(e) => { pendingDate.current = e.target.value; setDate(e.target.value); }}
        onBlur={commit}
        className={cn(
          `tabular min-w-0 shrink-0 border-none bg-transparent py-1 text-xs outline-none
           focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring`,
          MUTED_ON_ROW(selected),
        )}
      />
    </div>
  );
}

/**
 * The ambiguous-email review list (acceptance criterion 15).
 *
 * The engine already refuses to guess between two candidate applications and
 * parks the event for a human. Until now that decision had NO SURFACE: the
 * matched-nothing event sat in a tab nobody reads, so "neither row changed" was
 * indistinguishable from "no email arrived".
 *
 * It names the candidates and writes nothing. Picking one is a gesture this phase
 * does not build, and an item that offered a button which did nothing would be
 * worse than one that states the situation and links to the email.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT THE TEMPLATE'S "Needs review" BAND
 *
 * The authored composition pins a fourth band by that name above the others, and
 * what BELONGS in it is not derivable from the template — see the header comment
 * in `lib/applications/bands.ts` and open question #1 in
 * `job-hq-design-context/applications-handoff.md`. This section is the shipped,
 * demo-fed ambiguous-email list, rendered where it already rendered. It is
 * deliberately NOT relabelled into the band, because a band that silently pulls
 * rows out of Active is a list that lies about how much work is in flight.
 */
function NeedsReview({ items }: { items: ReviewItem[] }) {
  return (
    <section
      data-testid="needs-review"
      className="mt-4 overflow-hidden rounded-lg border border-border bg-warn-subtle/40"
    >
      <h2 className="tabular px-3 py-2 text-xs font-medium text-text">
        Needs review ({items.length})
      </h2>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} data-testid={`review-${item.id}`} className="px-3 py-3">
            <p className="min-w-0 break-words text-sm text-text">{item.summary}</p>
            {/* One candidate per line rather than glued together in a sentence.
                The labels carry their own commas, so any inline separator reads
                as part of a title — the line break is the separation. */}
            <p className="mt-1 text-xs text-muted">Could be:</p>
            <ul className="mt-0.5 text-xs text-text-2">
              {item.candidates.map((c) => (
                <li key={c.id} className="min-w-0 break-words">
                  {c.label}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">
              Nothing was changed. Open the email and set the status yourself.
            </p>
            {item.evidence ? (
              <a
                href={item.evidence}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-text"
              >
                <Mail aria-hidden="true" className="size-3" /> Open email
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
