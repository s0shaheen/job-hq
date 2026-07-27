"use client";

import * as React from "react";
import { AlertTriangle, Check, Info } from "lucide-react";
import type { PreviewResult } from "@/lib/profile/preview";
import { titleCoverage } from "@/lib/profile/preview";

/**
 * What the profile WOULD have let through — the whole reason this phase exists.
 *
 * Three numbers, in a fixed order, and every one of them is answering a
 * question somebody would otherwise answer wrong:
 *
 *   corpusTotal   how much there was to judge
 *   titleMatched  how much of it the engine is even sweeping for — reported
 *                 SEPARATELY, because a profile whose role family is new to the
 *                 system previews near-zero and that is not its fault
 *   qualified     what would reach the queue
 *
 * The panel never renders an unresolved spinner: a preview that cannot be
 * computed says so and offers the save anyway (matrix row 91). A person waiting
 * on a spinner concludes the app is broken; a person told "couldn't compute,
 * save and check your queue" has somewhere to go.
 */

const nf = new Intl.NumberFormat("en-US");

export type PreviewState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "stale"; preview: PreviewResult }
  | { kind: "ready"; preview: PreviewResult }
  | { kind: "failed"; message: string };

export function PreviewPanel({
  state,
  onGoToSetting,
}: {
  state: PreviewState;
  /** Focus + scroll the section a binding constraint names. */
  onGoToSetting: (setting: string) => void;
}) {
  if (state.kind === "idle") {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-dashed border-border-strong p-4 text-sm text-muted">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          Nothing has been checked yet. Running a check reads the last 30 days of
          postings and reports what these settings would have done with them. It
          writes nothing.
        </span>
      </p>
    );
  }

  if (state.kind === "running") {
    return (
      <p
        className="rounded-lg border border-border bg-surface p-4 text-sm text-muted"
        // Announced, because the numbers replacing this line are the answer to
        // a question the user just asked.
        aria-live="polite"
        data-testid="preview-running"
      >
        Checking the last 30 days…
      </p>
    );
  }

  if (state.kind === "failed") {
    return (
      <p
        className="flex items-start gap-2 rounded-lg border border-warn bg-surface p-4 text-sm"
        data-testid="preview-failed"
        aria-live="polite"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>
          Couldn’t compute the preview — {state.message}. You can still save and
          check your queue afterwards.
        </span>
      </p>
    );
  }

  const p = state.preview;
  const stale = state.kind === "stale";
  const coverage = titleCoverage(p);

  return (
    <div
      className="rounded-lg border border-border bg-surface p-4"
      data-testid="preview-panel"
      data-preview-state={state.kind}
      data-qualified={p.qualified}
      aria-live="polite"
    >
      {stale ? (
        // Matrix row 95. A number computed against settings that have since
        // changed is worse than no number, because it looks current.
        <p
          className="mb-3 rounded-md border border-warn px-2 py-1.5 text-xs"
          data-testid="preview-stale"
        >
          You’ve changed something since this was checked. Run it again to see
          what the new settings would do.
        </p>
      ) : null}

      <p className="text-sm">
        Of <strong className="tabular">{nf.format(p.corpusTotal)}</strong> postings
        collected in the last {p.windowDays} days, these settings would have
        qualified <strong className="tabular">{nf.format(p.qualified)}</strong> and
        filtered <strong className="tabular">{nf.format(p.filtered)}</strong>.
        {p.needsInfo > 0 ? (
          <>
            {" "}
            <span className="text-muted">
              {nf.format(p.needsInfo)} are still waiting to be analysed.
            </span>
          </>
        ) : null}
      </p>

      {coverage !== "ok" ? (
        <p
          className="mt-3 flex items-start gap-2 rounded-md border border-warn p-2 text-sm"
          data-testid="title-coverage-warning"
          data-coverage={coverage}
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
          {coverage === "no-titles" ? (
            <span>
              You haven’t listed any job titles yet, so nothing is being searched
              for by name. Add a few and the numbers above will mean something —
              the sweep matches a posting’s title against that list, and an empty
              list matches nothing.
            </span>
          ) : (
            <span>
              Only <strong className="tabular">{nf.format(p.titleMatched)}</strong> of
              those {nf.format(p.corpusTotal)} match your job titles. The engine has
              not been sweeping for this kind of role yet — your first full queue
              arrives after the next couple of sweeps, roughly 24 hours. The number
              above is not a verdict on your settings.
            </span>
          )}
        </p>
      ) : null}

      {p.binding ? (
        <p className="mt-3 text-sm" data-testid="binding-constraint">
          The single biggest filter is your{" "}
          <button
            type="button"
            onClick={() => onGoToSetting(p.binding!.setting)}
            data-testid="binding-link"
            data-setting={p.binding.setting}
            className="underline decoration-dotted underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {p.binding.label}
          </button>
          . Relaxing it alone would qualify{" "}
          <strong className="tabular">{nf.format(p.binding.recovers)}</strong> more.
          {p.binding.sample ? (
            <span className="block text-xs text-muted">
              For example: {p.binding.sample}
            </span>
          ) : null}
        </p>
      ) : p.qualified > 0 ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted">
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>No single setting is doing most of the filtering.</span>
        </p>
      ) : null}

      {p.samples.qualified.length ? (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-text-2">Examples that would reach you</h3>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            {p.samples.qualified.map((s) => (
              <li key={s.key} className="min-w-0 break-words">
                {s.company} — {s.title}
                {s.compRange ? ` · ${s.compRange}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {p.samples.filtered.length ? (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-text-2">Examples that would not</h3>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            {p.samples.filtered.map((s) => (
              <li key={s.key} className="min-w-0 break-words">
                {s.company} — {s.title} · {s.explanation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
