import { expect, test, type Locator, type Page } from "@playwright/test";
import { VISUAL_DIFF_ANNOTATION } from "./visual-diff-reporter";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * EVERY SHOT REPORTS WHAT IT MOVED — INCLUDING THE ONES THAT PASS.
 *
 * This is NOT a gate. It fails nothing, it tightens nothing, and a run that was
 * green before this file existed is green after it. It prints a number that was
 * always computed and always thrown away.
 *
 * WHY. Three consecutive PRs found a committed baseline defending something the
 * app no longer renders, and none of the three was found by the suite:
 *
 *   #248  `/queue` desktop pictured the pre-#121 nine-link nav and the retired
 *         triage card. 21,964 pixels, under a budget that was a RATIO.
 *   #280  22 of 28 baselines could have gone #ffffff -> #cccccc and counted
 *         zero, because the per-pixel `threshold` was never set.
 *   #283  the `/pipeline` pair says "8 in flight" over an "Active (7)" band the
 *         app has produced since #157 fixed the count in the same PR that
 *         recorded them. 26 pixels at threshold 0.01. The budget is 600.
 *
 * Both tolerances are now measured and correct, and #283 still sits 23x under
 * the budget at every threshold either issue considered. It is not a tolerance
 * problem. The common thread the third one named is that **a diff small enough
 * to sit under the budget is never looked at**, so a baseline can drift from
 * the app forever as long as each drift stays under 600. A wrong digit costs 26
 * pixels and always will; no plausible budget separates it from a legitimate
 * re-word, because #248 calibrated 600 to sit ABOVE a one-word copy edit on
 * purpose.
 *
 * So the answer is not another threshold. It is that the number stops being
 * invisible: `26 px` printed beside a passing shot is a thing a reviewer can
 * ask about, and "0 px" on the other 27 is what makes the 26 stand out. All
 * three of the above were nonzero-and-passing for months.
 *
 * HOW. The count is Playwright's own, not a second opinion. `toHaveScreenshot`
 * is asked for the same screenshot twice: once with the budget set to zero,
 * which makes the comparator report the count it computed in its error message,
 * and once with the suite's real options, which is the assertion that decides
 * the run. The probe inherits the config's `threshold`, so its count is counted
 * by exactly the rule the gate applies; only the budget differs, and it differs
 * in the strict direction — a probe can never let through what the gate would
 * catch. The probe's verdict is discarded. The gate's is the run's.
 *
 * WHAT IT COSTS. One extra screenshot per shot. A shot whose diff is zero
 * passes the probe on the first comparison, so the estate at rest pays a
 * screenshot and nothing else; a shot that has moved pays its retries, which is
 * the run you want to be slower anyway.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * The comparator's own sentence, from `coreBundle.js`:
 *
 *   `${count} pixels (ratio ${ratio} of all image pixels) are different.`
 *
 * Anchoring on it is deliberate. If Playwright ever reworded it this stops
 * matching, the error stops being recognised as a pixel mismatch, and it is
 * RETHROWN — the suite goes loud rather than silently reporting every shot as
 * unmoved, which is the failure mode this whole file exists to end.
 */
const COUNTED = /(\d+) pixels \(ratio [\d.]+ of all image pixels\) are different/;

/**
 * The ONLY per-shot option the suite uses, and the type is narrow on purpose.
 *
 * `visual-budget.test.ts` forbids a per-shot `maxDiffPixels` or `threshold` in
 * the spec, because "just this once" is how `/queue` carried its own budget for
 * two PRs. Routing every shot through a signature that cannot express either
 * one makes that structural rather than a rule someone has to remember: there
 * is no argument to pass.
 */
type ShotOptions = { fullPage?: boolean };

/**
 * Take the shot, report what it moved, and assert it against the budget.
 *
 * Replaces `expect(page).toHaveScreenshot(name, options)` one-for-one — the
 * assertion is the same call with the same options, and it is still the last
 * thing that happens.
 */
export async function expectShot(
  target: Page | Locator,
  name: string,
  options: ShotOptions = {},
): Promise<void> {
  const counted = await countedDiff(target, name, options);
  // An annotation rather than a `console.log`, because the CI reporter is
  // `github`, whose `printsToStdio()` is false: nothing a test writes to stdout
  // reaches the CI log. Annotations travel to the reporter, which prints them
  // from the runner process where nothing intercepts the stream.
  test.info().annotations.push({
    type: VISUAL_DIFF_ANNOTATION,
    description: JSON.stringify({ shot: name, counted }),
  });
  await expect(target).toHaveScreenshot(name, options);
}

/**
 * How many pixels this render differs from the committed baseline by, counted
 * at the config's threshold. `null` when there was nothing to count against.
 */
async function countedDiff(
  target: Page | Locator,
  name: string,
  options: ShotOptions,
): Promise<number | null> {
  // While RE-RECORDING there is no measurement to make: `--update-snapshots=all`
  // stops passing the baseline to the comparator at all, so a probe here would
  // report a confident 0 for every shot and write the file a second time on the
  // way. Say "not measured" instead of printing a zero that means nothing.
  const updating = test.info().config.updateSnapshots;
  if (updating === "all" || updating === "changed") return null;

  try {
    await expect(target).toHaveScreenshot(name, { ...options, maxDiffPixels: 0 });
    return 0;
  } catch (error) {
    const counted = COUNTED.exec(error instanceof Error ? error.message : String(error));
    // A missing baseline, a size change with no pixel line, a timeout that never
    // reached a comparison: none of those is a count, and swallowing one would
    // turn a real failure into a printed number. The gate below is entitled to
    // fail on it, so hand it back.
    if (!counted) throw error;
    return Number(counted[1]);
  }
}
