"use client";

import { Check, Clock, Star, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import type { JobView, Triage } from "@/lib/data/view-models";
import { setTriageAction } from "./actions";
import { TriageCard } from "./triage-card";

const UNDO_MS = 8000;

/** Days until a snooze wakes, by shortcut. */
const SNOOZE_DAYS = 3;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

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
}: {
  initial: JobView[];
  yoeMax?: number | null;
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
      const result = await setTriageAction({
        postingKey: job.key,
        triage,
        snoozeUntil: snooze ?? null,
        idempotencyKey: idem,
        expectedUpdatedAt: job.updatedAt,
      });
      setBusy(false);

      if (result.ok) {
        toast(labelFor(triage, job), {
          action: {
            label: "Undo",
            onClick: () => {
              void setTriageAction({
                postingKey: job.key,
                triage: "",
                idempotencyKey: crypto.randomUUID(),
                expectedUpdatedAt: result.job.updatedAt,
              }).then(() => {
                setQueue((q) => [job, ...q]);
                setDone((d) => Math.max(0, d - 1));
              });
            },
          },
          duration: UNDO_MS,
        });
        return;
      }

      // put it back — an optimistic removal must never outlive a failed write
      setQueue((q) => [job, ...q]);
      setDone((d) => Math.max(0, d - 1));
      if (result.kind === "conflict") {
        toast.warning("This was changed somewhere else — showing the latest.");
      } else {
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
    return (
      <EmptyState
        icon={<Check aria-hidden="true" className="size-8" />}
        title={total === 0 ? "Nothing to triage" : `Triaged all ${total} — nice.`}
        body={
          total === 0
            ? "New roles land here as they're found. Nothing needs you right now."
            : "The queue is clear. New roles arrive with the next sweep."
        }
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
