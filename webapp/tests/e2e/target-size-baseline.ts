/**
 * Pointer targets already under 24x24 CSS px when the 2.5.8 gate shipped.
 *
 * Same precedent as `scripts/assertion_lint_baseline.json` and the coverage
 * ledger's `BASELINE_MISSING`: dated, itemised, reported on every run, and NOT
 * a failure — while anything NEW fails immediately. The list may only shrink.
 *
 * Two things keep it from becoming an allowlist:
 *
 *   * an entry that matches NOTHING fails the run, so fixing a control means
 *     deleting its entry in the same commit;
 *   * `count` is asserted exactly, so a baselined selector cannot quietly start
 *     covering more offenders than it was recorded for. The e2e fixtures are
 *     byte-identical every run (that is what makes visual snapshots stable), so
 *     an exact count is a real assertion here rather than a flake.
 *
 * THE RULE WAS NEVER WIDENED TO FIT THIS DATA. Every entry is a genuine WCAG
 * 2.2 AA failure qualifying for none of the criterion's five exceptions, and
 * each names the component that owns the fix.
 */

export type TargetBaselineEntry = {
  /** Playwright project — `desktop` or `mobile`. A control can fail at one width only. */
  project: string;
  /** The route, exactly as listed in PAGES. */
  page: string;
  /** The offender's selector, exactly as the sweep reports it. */
  selector: string;
  /** How many offenders share that selector. Asserted exactly. */
  count: number;
  /** Measured box when recorded, and who owns the fix. */
  note: string;
};

export const TARGET_BASELINE_GENERATED = "2026-08-03";

/**
 * ONE defect, seven rows, both widths.
 *
 * `components/ds/decision-row.tsx` sizes the visible checkbox AND the input
 * that overlays it (`absolute inset-0 size-full`) with `size-4` — 16x16 — so
 * every queue row ships one, and the row's own action button sits within 12px
 * of its centre at both widths, spending the spacing exception. The user-agent
 * exception is refused because the author renders it 16x16 where the browser's
 * own checkbox is 13x13; there is no equivalent control for the per-row
 * selection; nothing about it is essential.
 *
 * NOT FIXED HERE deliberately. The fix is a larger hit area on a shared
 * design-system component that landed hours ago (#147) and is under active
 * edit; enlarging it moves `visual.spec.ts` baselines and belongs to whoever
 * owns that composition. Recorded so the gate can ship without either lying or
 * blocking, and so the row is a visible obligation rather than a silent one.
 */
export const DECISION_ROW_CHECKBOX =
  'li[data-testid="decision-row"] > span.relative.mt-0.5.inline-flex > input.peer.absolute.inset-0';

export const TARGET_BASELINE: TargetBaselineEntry[] = [
  {
    project: "desktop",
    page: "/queue",
    selector: DECISION_ROW_CHECKBOX,
    count: 7,
    note: "16x16, one per queue row. components/ds/decision-row.tsx `size-4`.",
  },
  {
    project: "mobile",
    page: "/queue",
    selector: DECISION_ROW_CHECKBOX,
    count: 7,
    note: "16x16, one per queue row. components/ds/decision-row.tsx `size-4`.",
  },
];
