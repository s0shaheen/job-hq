"use client";

import {
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight, ClipboardList, ExternalLink, Mail, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WarmCell } from "@/components/warm-cell";
import type { AppWriteResult } from "@/lib/data/source";
import type { ApplicationView } from "@/lib/data/view-models";
import { isDelisted } from "@/lib/data/view-models";
import { connectionsAt, universeFor, type WarmContext } from "@/lib/referral/match";
import { groupRank, isReopenable, statusGroup, statusRank } from "@/lib/status";
import {
  addNoteAction,
  resolveSuggestionAction,
  setNextActionAction,
  setStatusAction,
} from "./actions";
import { optimisticPatch } from "./optimistic";
import { NotesDialog } from "./notes-dialog";
import { StatusSelect } from "./status-select";

/**
 * The pipeline surface: one grouped, editable list.
 *
 * Grouped with `@tanstack/react-table`'s `getGroupedRowModel` and deliberately
 * NOT virtualized. The pipeline is tens of rows, not thousands, and
 * `@tanstack/react-virtual` inside collapsible groups is complexity bought for a
 * load that does not exist. The trigger to revisit is measured rather than
 * guessed: `pipeline.spec.ts` holds a render budget over a 200-row group, and
 * that assertion is what will say so.
 *
 * Collapsed state is URL state (`?open=Applied,Interview`), so back/forward works
 * and a link is shareable. Display preferences are NOT in the URL — a shared link
 * must not impose the sharer's eyesight (matrix row 67, learned on /jobs).
 */

/** Groups open when the URL says nothing: the live ladder, not the archive. */
const DEFAULT_OPEN_IS_TERMINAL_CLOSED = true;

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

export default function PipelineTable({ initial, reviewItems = [], warm }: Props) {
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
   * Which groups are open.
   *
   * `null` (param absent) is the DEFAULT, not "none open": a bare /pipeline must
   * show live work. An explicit empty `?open=` means everything collapsed, which
   * is a state a person can reach and therefore has to be representable.
   */
  const isOpen = React.useCallback(
    (group: string): boolean => {
      if (openParam === null) {
        return DEFAULT_OPEN_IS_TERMINAL_CLOSED ? !isArchived(group) : true;
      }
      return openParam.split(",").filter(Boolean).includes(group);
    },
    [openParam],
  );

  const groupsPresent = React.useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) seen.add(statusGroup(r.status));
    return [...seen].sort((a, b) => groupRank(a) - groupRank(b));
  }, [rows]);

  const toggleGroup = React.useCallback(
    (group: string) => {
      const current = groupsPresent.filter(isOpen);
      const next = current.includes(group)
        ? current.filter((g) => g !== group)
        : [...current, group];
      const params = new URLSearchParams(searchParams.toString());
      // Always written explicitly, even when it matches the default. A toggle
      // that produced a bare URL would read as "default" on the way back and
      // silently re-open a group the user closed — the shape of matrix row 65 on /jobs.
      params.set("open", next.join(","));
      // `push`, not `replace`: collapsing a group is a navigation the user may
      // want to undo with Back (matrix row 120; row 53's lesson on /jobs).
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [groupsPresent, isOpen, pathname, router, searchParams],
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
   *   auth     — revert and say the session expired. Deliberately NOT the queue's
   *              outbox: nothing here replays a pipeline gesture, and offering
   *              "saved on this device" for a write that is not queued anywhere
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
          toast.error("Couldn't save that — the server did not answer.", {
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
          toast.warning("Changed on another device — showing the latest.");
          return false;
        }
        put(before);
        if (result.kind === "auth") {
          toast.error("Couldn't save that — your session expired.", {
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

  const columns = React.useMemo<ColumnDef<ApplicationView>[]>(
    () => [
      {
        id: "status",
        accessorFn: (r) => statusGroup(r.status),
        // The grouping key. Sorting is applied to the GROUPS below rather than
        // through react-table's sorting model, because ladder order is not a
        // comparison on the accessor's string — "Applied" sorts above "Inbox".
      },
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { grouping: ["status"] },
    getRowId: (r) => String(r.id),
    getCoreRowModel: getCoreRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    // Every group is expanded in the row model; whether it is RENDERED is the
    // URL's business. Leaving expansion to react-table would put the state in
    // two places, and the URL is the one that survives a reload.
    manualExpanding: true,
  });

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, Row<ApplicationView>[]>();
    for (const row of table.getGroupedRowModel().rows) {
      const key = String(row.getValue("status") ?? "");
      byGroup.set(key, row.subRows);
    }
    return [...byGroup.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]));
  }, [table, rows]);

  return (
    <div
      className="min-w-0"
      data-testid="pipeline"
      data-saving={pending > 0 ? "true" : "false"}
      data-hydrated={hydrated ? "true" : "false"}
      data-writes={writes}
    >
      {/* `aria-live` so a screen-reader user gets the same signal a sighted one
          does. Removed from the DOM when idle rather than emptied, so it does not
          take up a line in the layout. */}
      {pending > 0 ? (
        <p
          role="status"
          aria-live="polite"
          className="px-4 py-1 text-2xs text-muted sm:px-6"
        >
          Saving…
        </p>
      ) : null}

      {reviewItems.length > 0 ? (
        <NeedsReview items={reviewItems} />
      ) : null}

      {groups.map(([group, subRows]) => {
        const open = isOpen(group);
        const items = subRows
          .map((r) => r.original)
          // Ordered by id, NOT by `updatedAt`.
          //
          // Sorting by recency read as "keep what you just touched near the top"
          // and does the opposite of what it says: every edit moves the row you
          // are working on, under your own cursor, and the next row you wanted is
          // somewhere else. `updatedAt` also moves for writes a person did not
          // make (a bot advancing a status), so the list reshuffles on its own.
          //
          // A stable key means the row stays put while you edit it, which is the
          // property a list you EDIT needs — the opposite trade from the queue,
          // which is a working set you walk once.
          .sort((a, b) => a.id - b.id);
        return (
          <section key={group} data-testid={`group-${group}`} className="border-b border-border">
            <h2>
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                aria-expanded={open}
                data-testid={`group-toggle-${group}`}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-semibold
                           text-text hover:bg-raised focus-visible:outline-2
                           focus-visible:outline-offset-[-2px] focus-visible:outline-ring sm:px-6"
              >
                {open ? (
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                )}
                <span className="min-w-0 break-words">{group}</span>
                <span className="tabular text-2xs font-normal text-muted">{items.length}</span>
              </button>
            </h2>

            {open ? (
              <ul className="divide-y divide-border">
                {items.map((app) => (
                  <PipelineRow
                    key={app.id}
                    app={app}
                    busy={busyId === app.id}
                    anyBusy={busyId !== null}
                    warm={warm}
                    onStatus={(s) => void changeStatus(app, s)}
                    onReopen={(note) => void changeStatus(app, "Applied", note)}
                    onResolve={(d) => void resolve(app, d)}
                    onAddNote={(body) => addNote(app, body)}
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
  );
}

/** Terminal and resolved states, plus Other — the archive half of the ladder. */
function isArchived(group: string): boolean {
  return statusRank(group) > statusRank("Offer");
}

function PipelineRow({
  app,
  busy,
  anyBusy,
  warm,
  onStatus,
  onReopen,
  onResolve,
  onAddNote,
  onNextAction,
}: {
  app: ApplicationView;
  busy: boolean;
  anyBusy: boolean;
  /** The warm-path indexes (0013), or absent on a surface without them. */
  warm?: WarmContext;
  onStatus: (status: string) => void;
  onReopen: (note: string) => void;
  onResolve: (decision: "confirm" | "reject") => void;
  onAddNote: (body: string) => Promise<boolean>;
  onNextAction: (text: string, date: string | null) => void;
}) {
  const delisted = isDelisted(app);
  const warmEntry = warm ? universeFor(warm.universe, app.company) : null;

  return (
    <li
      data-testid={`row-${app.id}`}
      data-busy={busy ? "true" : "false"}
      /* `hq-row` rather than a fixed `py-3`: the density knob is an <html>
         attribute, so it has to reach rows this component does not re-render. */
      className="hq-row px-4 hover:bg-raised sm:px-6"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        {/* `basis-full` under `sm`, not a rem basis at every width. `basis-64` is
            16rem, which DOUBLES to 512px at 200% text zoom — wider than a 375px
            phone — and the sibling column was then pushed off the page edge. Its
            own line on a phone, a shared one from `sm` up. */}
        <div className="min-w-0 grow basis-full sm:basis-64">
          <p className="min-w-0 break-words text-sm font-medium text-text">{app.company}</p>
          <p className="min-w-0 break-words text-xs text-text-2">
            {app.url ? (
              <a
                href={app.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                {app.title}
              </a>
            ) : (
              app.title
            )}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {delisted ? (
              <Badge
                tone="neutral"
                // Derived from the posting on every read, never stored — so it
                // stops being shown the moment the board reposts the role.
                title="The board no longer lists this posting. The application is unaffected."
                data-testid={`delisted-${app.id}`}
                className="whitespace-nowrap"
              >
                Posting closed
              </Badge>
            ) : null}
            {app.evidence ? (
              <a
                href={app.evidence}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`evidence-${app.id}`}
                className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-2xs text-muted
                           hover:bg-raised hover:text-text focus-visible:outline-2
                           focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Mail aria-hidden="true" className="size-3" /> Open email
                <ExternalLink aria-hidden="true" className="size-2.5" />
              </a>
            ) : null}
            <NotesDialog app={app} busy={anyBusy} onAdd={onAddNote} />
            {/* Prepare, beside the notes rather than as a column: this table is a
                stack of cards on a phone and a seventh column at 375px is the
                overflow row 123 measures — the same reasoning the warm chip is
                placed by.

                Shown on EVERY row, not only the ones Prepare can read. Which
                ones those are is a fact about the ATS family and the board link,
                and the surface that knows it is the one you land on: a link that
                appears and disappears teaches somebody that the feature is
                flaky, while a link that explains what it does not support
                teaches them what it does. */}
            <Link
              href={`/apply/${app.id}`}
              data-testid={`prepare-${app.id}`}
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-2xs text-muted
                         hover:bg-raised hover:text-text focus-visible:outline-2
                         focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ClipboardList aria-hidden="true" className="size-3" /> Prepare
            </Link>
            {/* The warm path, beside the evidence link rather than in a column
                of its own: this table is a stack of cards on a phone, and a
                seventh column at 375px is the overflow row 123 measures. The
                pairing is the design brief's — on `Applied`, the moment to work
                a referral is while the req is fresh. */}
            {warm ? (
              <WarmCell
                company={app.company}
                title={app.title}
                companyId={warmEntry?.linkedinCompanyId ?? ""}
                linkedinIdSource={warmEntry?.linkedinIdSource ?? ""}
                connections={connectionsAt(warm.connections, app.company)}
                universeId={warmEntry?.id ?? null}
                companyUpdatedAt={warmEntry?.companyUpdatedAt ?? null}
                hasAnyConnections={warm.hasAnyConnections}
              />
            ) : null}
          </div>
        </div>

        {/* NOT `shrink-0`. The status column holds a pill plus two buttons, and
            at 200% text that group is wider than a 375px phone — a column that
            refuses to shrink then paints straight past the page edge, where
            html's overflow-x:hidden clips it out of reach. It shrinks and its
            contents wrap instead. */}
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <StatusSelect
            applicationId={app.id}
            status={app.status}
            disabled={anyBusy}
            onSelect={onStatus}
          />
          {/* Confirm / "Not this" resolve a `suggested_status` a bot proposed.
              Honest scope: nothing writes that column in Postgres yet — no Python
              touches `applications`, and 0010 only reads and clears it — so on a
              real deployment these controls appear only if something else fills
              it. The mechanism, the SQL and the audit events are all real and
              tested; the producer is a later phase. */}
          {app.suggestedStatus ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="warn" className="whitespace-nowrap">
                suggests {app.suggestedStatus}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                disabled={anyBusy}
                onClick={() => onResolve("confirm")}
                data-testid={`confirm-${app.id}`}
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={anyBusy}
                onClick={() => onResolve("reject")}
                data-testid={`reject-${app.id}`}
              >
                Not this
              </Button>
            </div>
          ) : null}
          {isReopenable(app.status) ? (
            <ReopenControl id={app.id} disabled={anyBusy} onReopen={onReopen} />
          ) : null}
        </div>

        <div className="min-w-0 basis-full sm:basis-56">
          <NextActionCell app={app} onSave={onNextAction} />
        </div>
      </div>
    </li>
  );
}

/**
 * Reopen: terminal → Applied, with a mandatory note.
 *
 * The note requirement is enforced in SQL (`app_set_status` refuses an empty
 * body), so this form is the *explanation* of the rule rather than the rule. It
 * asks for the reason before sending, because a red toast saying "reopening
 * needs a note" after the click is a worse way to learn it.
 *
 * Lands on `Applied` rather than the pre-terminal status: the intermediate
 * history is in `events`, and guessing is worse than a known starting point.
 */
function ReopenControl({
  id,
  disabled,
  onReopen,
}: {
  id: number;
  disabled?: boolean;
  onReopen: (note: string) => void;
}) {
  const [asking, setAsking] = React.useState(false);
  const [note, setNote] = React.useState("");

  if (!asking) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setAsking(true)}
        data-testid={`reopen-${id}`}
      >
        <RotateCcw aria-hidden="true" className="size-3" /> Reopen
      </Button>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const body = note.trim();
        if (!body) return;
        setAsking(false);
        setNote("");
        onReopen(body);
      }}
    >
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setAsking(false);
            setNote("");
          }
        }}
        maxLength={4000}
        placeholder="Why is this alive again?"
        aria-label={`Reason for reopening application ${id}`}
        data-testid={`reopen-note-${id}`}
        className="min-w-0 grow basis-40 rounded-md border border-border bg-surface px-2 py-1
                   text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-1
                   focus-visible:outline-ring"
      />
      <Button
        type="submit"
        size="sm"
        variant="primary"
        disabled={!note.trim() || disabled}
        data-testid={`reopen-confirm-${id}`}
      >
        Reopen
      </Button>
    </form>
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
  onSave,
}: {
  app: ApplicationView;
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
    <div className="flex min-w-0 flex-wrap items-center gap-1">
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
        placeholder="Next action"
        className="min-w-0 grow basis-32 rounded-md border border-transparent bg-transparent px-1.5
                   py-1 text-xs text-text-2 hover:border-border focus:border-border focus:bg-surface
                   outline-none focus-visible:outline-2 focus-visible:outline-offset-1
                   focus-visible:outline-ring"
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
        className="tabular min-w-0 shrink rounded-md border border-transparent bg-transparent px-1
                   py-1 text-2xs text-muted hover:border-border focus:border-border
                   focus:bg-surface outline-none focus-visible:outline-2
                   focus-visible:outline-offset-1 focus-visible:outline-ring"
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
 * does not build — and an item that offered a button which did nothing would be
 * worse than one that states the situation and links to the email.
 */
function NeedsReview({ items }: { items: ReviewItem[] }) {
  return (
    <section data-testid="needs-review" className="border-b border-border bg-warn-subtle/40">
      <h2 className="px-4 py-2 text-xs font-semibold text-text sm:px-6">
        Needs review{" "}
        <span className="tabular text-2xs font-normal text-muted">{items.length}</span>
      </h2>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} data-testid={`review-${item.id}`} className="px-4 py-3 sm:px-6">
            <p className="min-w-0 break-words text-xs text-text">{item.summary}</p>
            <p className="mt-1 text-2xs text-muted">
              Could be:{" "}
              {item.candidates.map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 ? " · " : ""}
                  <span className="text-text-2">{c.label}</span>
                </React.Fragment>
              ))}
              . Nothing was changed — open the email and set the status yourself.
            </p>
            {item.evidence ? (
              <a
                href={item.evidence}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-2xs text-muted hover:text-text"
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
