"use client";

import { ArrowRight, Info } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ProposeCompaniesResult } from "@/lib/data/source";
import { proposeCompaniesAction } from "../actions";
import { MAX_NAME_LENGTH, MAX_PASTE_NAMES, parsePastedNames } from "../paste";

/**
 * The paste box.
 *
 * It previews the parse BEFORE submitting, and that is the whole design. Splitting
 * a pasted blob into names is guesswork — a CSV column, a comma-joined sentence and
 * a numbered list all look different, and a legal name containing a comma splits in
 * two. Showing the parsed list up front turns that guess into something the person
 * can see and correct in the textarea, instead of finding out later by way of twelve
 * proposals that make no sense. `parsePastedNames` is shared with the write path, so
 * what is previewed is byte-identical to what is written.
 *
 * No streaming, no progress theatre. The write is one transaction; it either lands
 * or it does not, and animating a wait that does not exist would be inventing a
 * process. What DOES happen after a submit is stated: rows go to the review set.
 */
export default function AddForm() {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const names = React.useMemo(() => parsePastedNames(text), [text]);
  const overLimit = names.length > MAX_PASTE_NAMES;
  // Long lines are dropped by the parser rather than truncated (truncating would
  // invent a company name), so the form says so instead of losing them silently.
  const droppedLong = React.useMemo(
    () =>
      text
        .split(/[\n\r,\t]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > MAX_NAME_LENGTH).length,
    [text],
  );

  const submit = async () => {
    if (pending || names.length === 0 || overLimit) return;
    setPending(true);
    setError(null);
    let res: ProposeCompaniesResult;
    try {
      res = await proposeCompaniesAction({
        names,
        source: "paste",
        idempotencyKey: crypto.randomUUID(),
      });
    } catch {
      setPending(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    setPending(false);
    if (!res.ok) {
      // The message stays in the form beside the box, not in a toast that vanishes:
      // it is a correction to make to the text the user still has on screen.
      setError(
        res.kind === "auth"
          ? "Your session expired. Sign in and try again."
          : res.message,
      );
      return;
    }

    const already = res.companies.length - res.added;
    setText("");
    toast(
      res.added === 0
        ? "Those are already in your universe"
        : `Added ${res.added} ${res.added === 1 ? "proposal" : "proposals"}`,
      {
        description:
          res.added === 0
            ? "Nothing new to review."
            : already > 0
              ? `${already} were already there. Review the new ones to record a decision.`
              : "Review them to record a decision on each.",
        action: { label: "Review", onClick: () => router.push("/companies?set=review") },
      },
    );
    // Refresh so the grid's server read picks the new rows up on arrival.
    router.refresh();
  };

  return (
    // `pb-40` on a phone is a SAFE AREA for the toaster, not spacing.
    //
    // The toast is bottom-anchored and ~75px tall, and this page is almost exactly
    // one screen: typing a second list opens the preview, which pushes the "Add N
    // companies" button down into the toast's strip. With the document exactly the
    // height of the viewport there was nowhere to scroll it clear, so the previous
    // paste's confirmation sat on top of the next one's button — and sonner pauses
    // its dismiss timer while a finger or cursor rests on the toaster, so waiting
    // does not necessarily help either. Reserving room below the form means the page
    // always scrolls far enough to lift the action out from under the strip.
    // (`closeButton` on the Toaster is the other way out, and stays.)
    <div className="mx-auto max-w-2xl px-4 py-6 pb-40 sm:px-6 sm:pb-10">
      {/* What this surface does and does not do, before the input rather than after
          it. A capability note that arrives only in an error message has already
          cost the person their time. */}
      <div className="flex gap-2 rounded-lg border border-border bg-raised p-3 text-xs text-text-2">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <p>
            This adds names, not boards.{" "}
            Pasted companies are tracked, not pulled. Nothing here looks for a job board. When
            discovery later finds one for a name, it upgrades that row in place, so the row
            becomes a real board and your subscription comes with it. Paste a company whose board
            is already known and you get that board straight away. One case still stalls: if the
            board it finds already belongs to another row here (a second spelling, say "Aon PLC"
            next to "Aon"), merging them would move your subscription, so nothing is changed and
            the row stays as a name only. That is recorded in your activity trail, not flagged on
            the row yet.
          </p>
          <p className="mt-1.5 text-muted">
            Describing a universe in words ("Chicago finance, treasury roles") is not wired up
            here yet. That path runs through the discovery agent, on the same schedule.
          </p>
        </div>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-medium text-text-2">Company names</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          data-testid="paste-box"
          placeholder={"Northern Trust\nCboe Global Markets\nGrainger, Aon, Exelon"}
          className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm
                     text-text placeholder:text-muted focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        />
        <span className="mt-1 block text-2xs text-muted">
          One per line, or comma-separated. Up to {MAX_PASTE_NAMES} at a time.
        </span>
      </label>

      {/* The parse, previewed. This is the feature. */}
      {text.trim() ? (
        <div
          data-testid="paste-preview"
          className="mt-3 rounded-lg border border-border bg-surface p-3"
        >
          <p className="text-xs font-medium text-text">
            {names.length === 0
              ? "Nothing recognised in that yet"
              : `${names.length} ${names.length === 1 ? "company" : "companies"} will be proposed`}
          </p>
          {names.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {names.slice(0, 60).map((n) => (
                <li
                  key={n}
                  className="min-w-0 max-w-full truncate rounded border border-border bg-raised px-1.5 py-0.5 text-2xs text-text-2"
                  title={n}
                >
                  {n}
                </li>
              ))}
              {names.length > 60 ? (
                <li className="px-1.5 py-0.5 text-2xs text-muted">
                  +{names.length - 60} more
                </li>
              ) : null}
            </ul>
          ) : null}
          {droppedLong > 0 ? (
            <p className="mt-2 text-2xs text-warn">
              {droppedLong} {droppedLong === 1 ? "line was" : "lines were"} longer than{" "}
              {MAX_NAME_LENGTH} characters and {droppedLong === 1 ? "was" : "were"} left out.
              Trimming one to a name would invent a company.
            </p>
          ) : null}
          {overLimit ? (
            <p role="alert" className="mt-2 text-2xs text-danger">
              That is {names.length} names; the limit is {MAX_PASTE_NAMES} per paste. Split it
              into smaller pastes.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="paste-error" className="mt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={pending || names.length === 0 || overLimit}
          onClick={() => void submit()}
          data-testid="paste-submit"
        >
          {pending
            ? "Adding"
            : `Add ${names.length || ""} ${names.length === 1 ? "company" : "companies"}`.trim()}
        </Button>
        <Link
          href="/companies?set=review"
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          Review what's waiting
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </div>
    </div>
  );
}
