"use client";

import { BadgeCheck, ChevronDown, CircleHelp, Fingerprint, HelpCircle } from "lucide-react";
import * as React from "react";
import type { CompanyView, ResolutionConfidence } from "@/lib/data/view-models";
import { confidenceLabel } from "@/lib/data/view-models";
import { computeCoverage, sharePct, ORACLE_UNMEASURED } from "@/lib/grid/coverage";
import { rowsForCompanySet } from "@/lib/grid/company-presets";
import { cn } from "@/lib/utils";

/**
 * The coverage meter — and the most careful thing on this surface.
 *
 * The teardown asks for `142/180 resolved · 84% Tier-1 day-of · 8% Tier-2 · 8%
 * unresolved`. The critic's caveat, in the same document, is that exactly that
 * string "would render T1's soft estimate as if measured": two rows both reading
 * "Tier 1" can be a Greenhouse API answer and an unprobed Common Crawl slug, and
 * the research pass's own Dad figure was **47% grounded against a ~75%
 * best-estimate**. Printing the second number as the headline is how a plan's one
 * genuinely uncertain quantity becomes a fact on a dashboard.
 *
 * So this widget is built to three rules:
 *
 *  1. **The headline number is the VERIFIED one.** "N of M day-of, confirmed" counts
 *     only rows a board API actually answered for. The tier-1 total is shown beside
 *     it, as the larger, softer number it is — never in its place.
 *  2. **Every bar segment is a confidence, not a tier.** The stacked rail reads
 *     verified / inferred / unverified / unresolved, so the grounded fraction is a
 *     visible width rather than a footnote. Tier detail expands underneath.
 *  3. **Recall has a labelled empty slot.** `monitor/oracle.py` is the only thing
 *     that can answer "what fraction of the universe is this", it is a keyed Python
 *     job, and nothing writes its result anywhere this app reads. The slot says that
 *     in words. Omitting the row entirely would be worse: a reader would take
 *     "84% verified" as recall, which is the misreading the whole design fears.
 *
 * It describes the APPROVED set, and says so on screen. A proposal nobody has
 * accepted is not coverage of anything, and a meter that quietly counted the review
 * pile would climb every time discovery ran and fall the moment someone did their
 * job.
 */

const STYLE: Record<
  ResolutionConfidence,
  { bar: string; text: string; icon: typeof BadgeCheck; blurb: string }
> = {
  verified: {
    bar: "bg-ok",
    text: "text-ok",
    icon: BadgeCheck,
    blurb: "a board API answered — jobs have been pulled from here",
  },
  inferred: {
    bar: "bg-info",
    text: "text-info",
    icon: Fingerprint,
    blurb: "identified by fingerprint or aggregator, with no board call behind it",
  },
  asserted: {
    bar: "bg-warn",
    text: "text-warn",
    icon: CircleHelp,
    blurb: "a slug or name taken on trust and never re-probed",
  },
  unresolved: {
    bar: "bg-border-strong",
    text: "text-muted",
    icon: HelpCircle,
    blurb: "no board found yet, so nothing is pulled",
  },
};

const ORDER: ResolutionConfidence[] = ["verified", "inferred", "asserted", "unresolved"];

export default function CoverageMeter({ rows }: { rows: CompanyView[] }) {
  const [open, setOpen] = React.useState(false);
  // Always the approved set, whatever working set the grid is showing — see the
  // module comment. The grid states which set IT is showing; this states its own.
  const universe = React.useMemo(() => rowsForCompanySet(rows, "universe"), [rows]);
  const c = React.useMemo(() => computeCoverage(universe), [universe]);

  const tier1 = c.byTier[0];

  return (
    <section
      data-testid="coverage-meter"
      aria-label="Universe coverage"
      className="shrink-0 border-b border-border px-4 py-2 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The headline is the VERIFIED count. Rule 1. */}
        <p className="text-xs text-text">
          <strong data-testid="coverage-verified" className="tabular font-semibold">
            {c.verifiedTier1} of {c.total}
          </strong>{" "}
          <span className="text-text-2">
            approved companies have a confirmed day-of board
          </span>
        </p>
        {/* The softer, larger number, explicitly labelled as an expectation. */}
        {tier1.count > c.verifiedTier1 ? (
          <p data-testid="coverage-expected" className="text-2xs text-muted">
            {tier1.count} are marked Tier 1, so {tier1.count - c.verifiedTier1} of those{" "}
            {tier1.count - c.verifiedTier1 === 1 ? "is" : "are"} expected rather than seen
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="coverage-toggle"
          className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted
                     hover:bg-raised hover:text-text-2 focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        >
          {open ? "Hide detail" : "How this is counted"}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {/* The rail. Segments are CONFIDENCES, not tiers — rule 2. `role=img` with a
          full text alt: a stacked bar is decoration to a screen reader unless it
          carries the same sentence a sighted reader gets from its widths. */}
      <div
        role="img"
        data-testid="coverage-rail"
        aria-label={ORDER.map((k) => `${c.byConfidence[k]} ${confidenceLabel(k)}`).join(", ")}
        className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-raised"
      >
        {ORDER.map((k) => {
          const n = c.byConfidence[k];
          if (n === 0) return null;
          return (
            <span
              key={k}
              data-testid={`coverage-seg-${k}`}
              // Inline width because it is data, not design: a Tailwind class cannot
              // express an arbitrary percentage, and rounding to the nearest w-* step
              // would make the rail disagree with the numbers beside it.
              style={{ width: `${sharePct(n, c.total)}%` }}
              className={cn("h-full", STYLE[k].bar)}
            />
          );
        })}
      </div>

      <ul className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs">
        {ORDER.map((k) => {
          const n = c.byConfidence[k];
          const Icon = STYLE[k].icon;
          return (
            <li key={k} className="flex items-center gap-1">
              <Icon aria-hidden="true" className={cn("size-3 shrink-0", STYLE[k].text)} />
              <span className="tabular text-text-2">{n}</span>
              <span className="text-muted">{confidenceLabel(k)}</span>
            </li>
          );
        })}
      </ul>

      {open ? (
        <div data-testid="coverage-detail" className="mt-2 border-t border-border pt-2">
          <dl className="space-y-1 text-2xs">
            {ORDER.map((k) => (
              <div key={k} className="flex flex-wrap gap-x-1.5">
                <dt className={cn("font-medium", STYLE[k].text)}>{confidenceLabel(k)}</dt>
                <dd className="min-w-0 flex-1 text-muted">{STYLE[k].blurb}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-2 text-2xs text-muted">
            By tier:{" "}
            {c.byTier.map((t, i) => (
              <React.Fragment key={t.tier}>
                {i > 0 ? " · " : ""}
                <span className="text-text-2">
                  Tier {t.tier}: {t.count}
                </span>
                {t.count > 0 ? ` (${t.verified} confirmed)` : ""}
              </React.Fragment>
            ))}
            {c.unresolved > 0 ? ` · unresolved: ${c.unresolved}` : ""}
          </p>

          {/* Rule 3: the oracle's slot, named and empty. */}
          <p
            data-testid="coverage-oracle-slot"
            className="mt-2 border-t border-border pt-2 text-2xs text-muted"
          >
            <span className="font-medium text-text-2">Recall: not measured.</span> These numbers
            describe the companies in your universe, not the share of companies that exist. Working
            out the second needs a facet denominator from the coverage oracle, which runs outside
            this app —{" "}
            {ORACLE_UNMEASURED.denominator === null
              ? "no measurement has been recorded, so none is shown."
              : `last measured denominator: ${ORACLE_UNMEASURED.denominator}.`}
          </p>
        </div>
      ) : null}
    </section>
  );
}
