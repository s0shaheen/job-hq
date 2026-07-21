"use client";

import { Check, Clock, Filter, Inbox, Star, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import type { WriteResult } from "@/lib/data/source";
import type { BindingConstraint, JobView, Triage } from "@/lib/data/view-models";
import { localIsoDaysFromNow } from "@/lib/dates";
import { dequeue, enqueue } from "@/lib/outbox";
import { setTriageAction } from "./actions";
import { TriageCard } from "./triage-card";

const UNDO_MS = 8000;

/** Days until a snooze wakes, by shortcut. */
const SNOOZE_DAYS = 3;

/**
 * The wake date, on the user's LOCAL calendar — see lib/dates.ts for why this
 * is not `toISOString().slice(0, 10)` (acceptance criterion 14).
 */
const isoDaysFromNow = (days: number) => localIsoDaysFromNow(days);

/** Flags the exact gaps that caused abandoned shortlists, without auto-rejecting. */
function mismatchFor(job: JobView, yoeMax: number | null): string | null {
  if (yoeMax !== null && job.minYoe !== null && job.minYoe > yoeMax) {
    return `Asks for ${job.minYoe}+ years — ${job.minYoe - yoeMax} above your limit of ${yoeMax}.`;
  }
  if (job.compRange === null) return "Compensation is not listed — worth checking before you invest time.";
  return null;
}

export default function TriageQueue({
  initial,
  yoeMax = null,
  constraint = null,
}: {
  initial: JobView[];
  yoeMax?: number | null;
  /**
   * Set only when the server found postings and the profile removed all of
   * them. Computed on the server because it needs every posting, not the
   * twenty this component was handed.
   */
  constraint?: BindingConstraint | null;
}) {
  // Seeded once. The server list is the starting point, not a live feed —
  // see the note in actions.ts about not revalidating this path.
  const [queue, setQueue] = React.useState<JobView[]>(initial);
  const [index, setIndex] = React.useState(0);
  const [done, setDone] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [total] = React.useState(initial.length);
  // False until the keydown listener below is actually attached. The card
  // renders on the server with its shortcut hints visible, but nothing is
  // listening until React hydrates — on a slow machine that window is long
  // enough for a real keystroke to vanish. Rather than let the UI promise a
  // shortcut it cannot yet honour, readiness is explicit: the hints stay dim
  // until it flips, and the E2E tests wait for it instead of racing it.
  const [ready, setReady] = React.useState(false);

  // As rows leave, the cursor stays in range rather than falling off the end.
  const safeIndex = Math.min(index, Math.max(0, queue.length - 1));
  const current = queue[safeIndex] ?? null;

  const decide = React.useCallback(
    async (job: JobView, triage: Triage, snooze?: string) => {
      if (busy) return;
      setBusy(true);
      // optimistic: the row leaves immediately, so triage stays fast
      setQueue((q) => q.filter((j) => j.key !== job.key));
      setDone((d) => d + 1);

      const idem = crypto.randomUUID();
      const input = {
        postingKey: job.key,
        triage,
        snoozeUntil: snooze ?? null,
        idempotencyKey: idem,
        expectedUpdatedAt: job.updatedAt,
      };

      /**
       * Hold the decision instead of discarding it.
       *
       * Reverting here would be the wrong kindness: the decision was valid and
       * the user would have to make it again, on a card that has already left
       * the screen. The row stays gone, the gesture goes to the outbox, and the
       * banner in the shell owns delivering it.
       */
      const defer = (reason: "offline" | "auth") => {
        enqueue({ id: idem, input, label: labelFor(triage, job), queuedAt: Date.now(), reason });
        setBusy(false);
        toast(labelFor(triage, job), {
          description:
            reason === "auth"
              ? "Saved on this device — sign in to apply it."
              : "Saved on this device — it'll sync when you're back online.",
          action: {
            label: "Undo",
            onClick: () => {
              // Never delivered, so undo is just dropping it. No server call,
              // which is the only thing that could work while offline anyway.
              dequeue(idem);
              setQueue((q) => [job, ...q]);
              setDone((d) => Math.max(0, d - 1));
            },
          },
          duration: UNDO_MS,
        });
      };

      let result: WriteResult;
      try {
        result = await setTriageAction(input);
      } catch {
        // The action never reached the server: offline, a dropped connection,
        // or a deploy mid-gesture. Previously this threw into a void and the
        // card vanished with nothing written anywhere.
        defer("offline");
        return;
      }

      if (!result.ok && result.kind === "auth") {
        defer("auth");
        return;
      }

      setBusy(false);

      if (result.ok) {
        // `result.job` — NOT the `job` this closure captured.
        //
        // Restoring the stale object put a card back carrying the updated_at it
        // had BEFORE the write. The next gesture on it therefore sent a version
        // the server had already moved past, conflicted, and restored the same
        // stale object again: triage, undo, change your mind, and the card is
        // permanently un-triageable until a reload, with a toast claiming
        // somebody else changed it. Nothing else had changed it.
        const written = result.job;
        toast(labelFor(triage, job), {
          action: {
            label: "Undo",
            onClick: () => {
              void (async () => {
                let undo: WriteResult;
                try {
                  undo = await setTriageAction({
                    postingKey: written.key,
                    triage: "",
                    idempotencyKey: crypto.randomUUID(),
                    expectedUpdatedAt: written.updatedAt,
                  });
                } catch {
                  // The undo never reached the server. It is a decision like
                  // any other, so it goes to the outbox rather than being
                  // dropped — previously this threw into an unhandled rejection
                  // and the card came back on screen while the server kept the
                  // original decision.
                  const idem = crypto.randomUUID();
                  enqueue({
                    id: idem,
                    input: {
                      postingKey: written.key,
                      triage: "",
                      snoozeUntil: null,
                      idempotencyKey: idem,
                      expectedUpdatedAt: written.updatedAt,
                    },
                    label: `Undo ${labelFor(triage, job)}`,
                    queuedAt: Date.now(),
                    reason: "offline",
                  });
                  setQueue((q) => [written, ...q]);
                  setDone((d) => Math.max(0, d - 1));
                  return;
                }

                if (undo.ok) {
                  setQueue((q) => [undo.job, ...q]);
                  setDone((d) => Math.max(0, d - 1));
                  return;
                }
                // An undo that failed must say so. Silently restoring the card
                // told the user it was undone while the server kept the
                // decision — the screen and the database disagreeing, with
                // nothing on screen admitting it.
                if (undo.kind === "auth") {
                  toast.error("Couldn't undo — your session expired.", {
                    description: "Sign in and try again.",
                  });
                } else if (undo.kind === "conflict") {
                  toast.warning("Couldn't undo — this was changed somewhere else.");
                } else {
                  toast.error("Couldn't undo that.", { description: undo.message });
                }
              })();
            },
          },
          duration: UNDO_MS,
        });
        return;
      }

      // put it back — an optimistic removal must never outlive a failed write
      if (result.kind === "conflict") {
        // Re-insert the row the SERVER has, not the one we tried to write over.
        // The toast says "showing the latest"; putting the stale object back
        // made that a lie and left the card unable to accept another gesture.
        setQueue((q) => [result.current, ...q]);
        setDone((d) => Math.max(0, d - 1));
        toast.warning("This was changed somewhere else — showing the latest.");
      } else {
        setQueue((q) => [job, ...q]);
        setDone((d) => Math.max(0, d - 1));
        toast.error("Couldn't save that.", {
          description: result.message,
          action: { label: "Retry", onClick: () => void decide(job, triage, snooze) },
        });
      }
    },
    [busy],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // A modal is modal. This handler is on `window`, so with the export
      // dialog open a plain `i` still triaged the card hidden behind it — the
      // user is reading a dialog and a decision happens on a row they cannot
      // see. Radix marks the open dialog; nothing else needs to know about it.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (!current) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setIndex(() => Math.min(safeIndex + 1, queue.length - 1));
          break;
        case "k":
          e.preventDefault();
          setIndex(() => Math.max(safeIndex - 1, 0));
          break;
        case "i":
          e.preventDefault();
          void decide(current, "interested");
          break;
        case "x":
          e.preventDefault();
          void decide(current, "dismissed");
          break;
        case "s":
          e.preventDefault();
          void decide(current, "snoozed", isoDaysFromNow(SNOOZE_DAYS));
          break;
        case "o":
          if (el && /^(A|BUTTON)$/.test(el.tagName)) return;
          e.preventDefault();
          window.open(current.url, "_blank", "noopener,noreferrer");
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    setReady(true);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, queue.length, safeIndex, decide]);

  if (!current) {
    // Three different states wearing one panel until now. Finishing is a
    // reward and should read like one; nothing found is a quiet day and needs
    // to say when to expect more; a profile that gated everything out is a
    // setting the user can widen, and saying "nothing to triage" there is how
    // a working system convinces someone it is dead.
    if (total > 0) {
      return (
        <EmptyState
          icon={<Check aria-hidden="true" className="size-8" />}
          title={`Triaged all ${total} — nice.`}
          body="The queue is clear. New roles arrive with the next sweep."
        />
      );
    }
    if (constraint) {
      return (
        <EmptyState
          icon={<Filter aria-hidden="true" className="size-8" />}
          title={`Your ${constraint.label} filtered everything out`}
          body={`That setting removed ${constraint.filtered} of the ${constraint.total} postings found. For example: ${constraint.example}.`}
          action={
            <Link
              href={`/settings#${constraint.setting}`}
              className={buttonClass({ variant: "primary" })}
            >
              Adjust your {constraint.label}
            </Link>
          }
        />
      );
    }
    return (
      <EmptyState
        icon={<Inbox aria-hidden="true" className="size-8" />}
        title="Nothing found yet"
        body="Roles land here as the sweeps find them, twice a day. Nothing needs you right now."
      />
    );
  }

  return (
    <div
      data-testid="triage"
      data-ready={ready ? "true" : "false"}
      className="mx-auto max-w-2xl px-4 py-5 sm:px-6 data-[ready=false]:[&_kbd]:opacity-40"
    >
      <div className="mb-3 flex items-baseline justify-between text-xs text-muted">
        <span className="tabular" data-testid="progress">
          {Math.min(done + 1, total)} of {total}
        </span>
        <span>{queue.length} left</span>
      </div>

      <TriageCard job={current} mismatch={mismatchFor(current, yoeMax)} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => void decide(current, "dismissed")}
          disabled={busy}
          data-testid="pass"
        >
          <X aria-hidden="true" className="size-3.5" /> Pass <Kbd>x</Kbd>
        </Button>
        <Button
          variant="secondary"
          onClick={() => void decide(current, "snoozed", isoDaysFromNow(SNOOZE_DAYS))}
          disabled={busy}
        >
          <Clock aria-hidden="true" className="size-3.5" /> Later <Kbd>s</Kbd>
        </Button>
        <div className="grow" />
        <Button
          variant="primary"
          onClick={() => void decide(current, "interested")}
          disabled={busy}
          data-testid="interested"
        >
          <Star aria-hidden="true" className="size-3.5" /> Interested <Kbd>i</Kbd>
        </Button>
      </div>

      <p className="mt-4 text-2xs text-muted">
        <Kbd className="ml-0">j</Kbd> <Kbd>k</Kbd> move · <Kbd>i</Kbd> interested ·{" "}
        <Kbd>x</Kbd> pass · <Kbd>s</Kbd> later · <Kbd>o</Kbd> open. Every decision can be
        undone for {UNDO_MS / 1000} seconds.
      </p>
    </div>
  );
}

function labelFor(triage: Triage, job: JobView): string {
  const who = `${job.company} — ${job.title}`;
  if (triage === "interested") return `Saved ${who}`;
  if (triage === "dismissed") return `Passed on ${who}`;
  if (triage === "snoozed") return `Snoozed ${who}`;
  return who;
}
