"use client";

import * as React from "react";
import type { CompanyView } from "@/lib/data/view-models";
import { rowsForCompanySet } from "@/lib/grid/company-presets";
import { computeCoverage } from "@/lib/grid/coverage";

/**
 * The summary sentence that replaces the coverage meter.
 *
 * `Coverage.dc.html` line 25 is one sentence with two numbers, and the design
 * guardrail behind it is explicit: no meters, gauges or progress rings for
 * coverage or confidence. The meter this replaces was BUILT to stop a
 * reliability rank reading as a measurement — a stacked rail, a percentage-free
 * headline, a labelled empty recall slot — and it still read as one, because a
 * bar is a measurement to the eye whatever its caption says. A sentence with two
 * numbers cannot be misread that way.
 *
 * The arithmetic is unchanged: `computeCoverage` over the APPROVED set, which is
 * the meter's own argument and still holds — a proposal nobody has accepted is
 * not coverage of anything, and counting the review pile would make the number
 * climb every time discovery ran and fall the moment someone did their job.
 *
 * WHAT "WATCHING N" COUNTS. The handoff's open question 3 asks whether N is
 * companies with a readable board or companies with the toggle on, and answers
 * it from the sentence's own arithmetic: the second clause is "no job board the
 * system can read yet", so N and the second number have to partition the total,
 * which makes N the RESOLVED count. `resolved` here keys off the displayed
 * source quality rather than off the tier column, so the sentence can never
 * disagree with the chips in the table beneath it.
 *
 * There is no division anywhere in this component, which is how the empty
 * universe stopped being a hazard: "Watching 0 of 0 companies." is a true
 * sentence, where the meter's percentage was an NaN waiting for a first user.
 *
 * The second sentence is omitted when nothing is unresolved. The template shows
 * it because its mock has sixteen; printing "0 have no job board" would state an
 * absence as if it were news.
 */
export default function CoverageSummary({ rows }: { rows: CompanyView[] }) {
  const universe = React.useMemo(() => rowsForCompanySet(rows, "universe"), [rows]);
  const c = React.useMemo(() => computeCoverage(universe), [universe]);

  return (
    <p
      data-testid="coverage-summary"
      className="shrink-0 border-b border-border px-4 py-2 text-sm tabular-nums text-text-2 sm:px-6"
    >
      <span data-testid="coverage-watching">
        Watching {c.resolved} of {c.total}
      </span>{" "}
      {c.total === 1 ? "company" : "companies"}.
      {c.unresolved > 0 ? (
        <>
          {" "}
          <span data-testid="coverage-unresolved">{c.unresolved}</span>{" "}
          {c.unresolved === 1 ? "has" : "have"} no job board the system can read yet.
        </>
      ) : null}
    </p>
  );
}
