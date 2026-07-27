import { Button, StepHeader, buttonClass } from "hq-webapp";

/**
 * The import wizard's four headings, in order, ported from the step components
 * themselves (app/(app)/import/{map,preview,commit,report}-step.tsx).
 *
 * "Step N of 4" is stated rather than implied because a person needs to know how
 * much is left, and the filename rides beside it so a second import in another
 * tab is never mistaken for this one. The title wraps rather than truncating: a
 * truncated heading beside a non-shrinking button renders as a bare ellipsis at
 * 200% zoom on a 320px phone.
 */

export function MapColumns() {
  return (
    <StepHeader
      title="Which column is which?"
      filename="pipeline-export-2026-07.xlsx"
      step={1}
      detail={<>1,284 rows would be imported, and 2 above the header row would not.</>}
    />
  );
}

/** Step 2 carries the commit action, so the header takes an `actions` slot. */
export function WhatThisWouldDo() {
  return (
    <StepHeader
      title="What this would do"
      filename="pipeline-export-2026-07.xlsx"
      step={2}
      detail={
        <>
          1,281 of 1,284 rows will be imported (2 rows at the top of the file hold the
          column names and 1 is empty).
        </>
      }
      actions={<Button variant="primary">Import 1,281 rows</Button>}
    />
  );
}

/** Step 3 is the only one with no way out — the detail says what a close costs. */
export function Importing() {
  return (
    <StepHeader
      title="Importing"
      filename="Pasted rows"
      step={3}
      detail={
        <>
          200 rows at a time, each batch on its own. Closing this tab stops it where it is
          — nothing is half-written, and opening this import again carries on from the
          same place.
        </>
      }
    />
  );
}

/**
 * Step 4, with a long filename and an anchor styled as a button — the wrap rule
 * and the anchor idiom in one card.
 */
export function Report() {
  return (
    <StepHeader
      title="Imported"
      filename="Simplify-jobs-and-applications-export-2026-07-21-full.xlsx"
      step={4}
      detail={<>1,281 of 1,284 rows settled · 21 Jul 2026, 15:04.</>}
      actions={
        <a href="#pipeline" className={buttonClass({ variant: "secondary", size: "sm" })}>
          Go to the pipeline
        </a>
      }
    />
  );
}
