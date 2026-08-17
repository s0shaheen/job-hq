import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * THE COUNTS, PRINTED. See `visual-diff.ts` for why they are worth printing;
 * this file is only the part that gets them in front of a person.
 *
 * It adds NO verdict. It reads annotations off results that have already been
 * decided, prints them, and returns. `onEnd` returns nothing, so the run's
 * status is untouched by construction — there is no branch in here that could
 * fail a run even by accident.
 *
 * WHY A REPORTER AND NOT A `console.log`. The CI job runs the `github`
 * reporter, whose `printsToStdio()` is `false`, and no other configured
 * reporter prints test output either — so a `console.log` from inside a test is
 * collected into the report and never reaches the CI log. That is precisely the
 * audience this is for. A reporter runs in the runner process, where nothing
 * intercepts the stream, so it prints under every reporter selection: `github`
 * on CI, `list` on a laptop, `line` under `scripts/record-baselines.sh`.
 *
 * `tests/live/reporter.ts` is the precedent, in both mechanism and purpose: it
 * exists so a fixture run cannot be misread as full coverage, and it writes to
 * stderr for the same reason.
 *
 * Silent for any run with no visual shots in it — which is every run outside
 * the container, since `visual.spec.ts` skips without HQ_VISUAL.
 *
 * THE FLOOR, MEASURED, because the summary tells a reader how to read a count.
 * Eight runs of this suite, desktop/mobile:
 *
 *   pipeline-light   26/26 on every run before the re-record, 0/0 on every run
 *                    after. A wrong digit is deterministic, which is the whole
 *                    reason it was findable at 26 pixels.
 *   companies-light  120/120 and 167/120 before the re-record — the switch's
 *                    radius, plus noise. After it: 47/47 three runs running,
 *                    then 0/0 three runs running.
 *   queue-light      0/0, 0/39, 38/0, 0/0, 0/0, then 38/39 three runs running.
 *
 * One commit, one set of baselines, and the two wobbling shots are the two that
 * draw the same bitmap company logo. So: a count that survives a re-record and
 * keeps coming back is drift, and tens of pixels that appear and vanish are this
 * container rounding an image. Neither is anywhere near the 600 that decides the
 * run, which is the other half of why this prints rather than fails.
 */

/** The annotation `expectShot` writes and this reads. */
export const VISUAL_DIFF_ANNOTATION = "visual-diff";

type Measurement = {
  /** The snapshot name as the spec writes it, e.g. `pipeline-light.png`. */
  shot: string;
  /** Pixels counted at the config's `threshold`; `null` while re-recording. */
  counted: number | null;
};

const RULE = "─".repeat(72);

export default class VisualDiffReporter implements Reporter {
  /** Keyed by project + shot, so a retried test reports once, with its last result. */
  private readonly measured = new Map<string, Measurement & { project: string }>();

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const annotation of result.annotations ?? []) {
      if (annotation.type !== VISUAL_DIFF_ANNOTATION || !annotation.description) continue;
      let parsed: Measurement;
      try {
        parsed = JSON.parse(annotation.description) as Measurement;
      } catch {
        // A malformed annotation is this file's bug, not the run's. Skipping it
        // loses a line of output and nothing else.
        continue;
      }
      const project = test.parent.project()?.name ?? "";
      this.measured.set(`${project} ${parsed.shot}`, { ...parsed, project });
    }
  }

  onEnd(_result: FullResult): void {
    if (this.measured.size === 0) return;

    const rows = [...this.measured.values()].sort(
      (a, b) => a.shot.localeCompare(b.shot) || a.project.localeCompare(b.project),
    );
    const moved = rows.filter((r) => (r.counted ?? 0) > 0);
    const width = Math.max(...rows.map((r) => String(r.counted ?? "—").length));
    const project = Math.max(...rows.map((r) => r.project.length));

    const out = [
      "",
      RULE,
      " visual: what each shot moved against its committed baseline",
      "",
      " A count here is INFORMATION, NOT A VERDICT. The run's pass or fail is the",
      " budget in playwright.config.ts, which none of these numbers change. They are",
      " printed because a diff that stays under the budget is otherwise never looked",
      " at, and three baselines have drifted out of the app's reach that way (#283).",
      RULE,
    ];
    for (const row of rows) {
      const count = String(row.counted ?? "—").padStart(width);
      out.push(
        `   ${count} px  ${row.project.padEnd(project)}  ${row.shot}` +
          (row.counted === null ? "   (not measured: re-recording)" : "") +
          ((row.counted ?? 0) > 0 ? "   <- MOVED" : ""),
      );
    }
    out.push(RULE);
    out.push(
      moved.length === 0
        ? ` ${rows.length} shots, none moved.`
        : ` ${moved.length} of ${rows.length} shots moved. A shot that moves without failing is` +
          `\n exactly how a baseline drifts away from the app one sub-budget diff at a time.` +
          `\n\n A count that REPEATS run after run is drift, and opening its PNG is the only` +
          `\n way to know what of. A count that comes and goes is this container rounding a` +
          `\n bitmap company logo, which is worth tens of pixels either way.`,
    );
    out.push("");
    process.stderr.write(out.join("\n") + "\n");
  }
}
