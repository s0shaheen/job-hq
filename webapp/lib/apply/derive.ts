import "server-only";

import { FIXTURE_NOW } from "@/lib/data/fixtures";
import { isDemoMode, type DataSource } from "@/lib/data/source";
import { companyNameKey } from "@/lib/data/view-models";
import { resolveApplyTarget } from "./board";
import { getBoardSource, type BoardSource } from "./board-source";
import { parseGreenhouseForm } from "./greenhouse";
import { AutopilotMappingError, toStagePackage, type StagePackage } from "./persist";
import { prepareApplication } from "./prepare";
import { engineAnswers, engineRules } from "./views";

/**
 * The package a stage write persists, DERIVED ON THE SERVER from the user's own
 * stored rows — never accepted from the browser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE CLIENT DOES NOT SEND THE PACKAGE
 *
 * The first version of `stageAutopilotAction` took the mapped package as an
 * argument and validated `answers[*].source` against the four-word vocabulary.
 * An independent security review found the hole that leaves: a browser could
 * simply ASSERT `source: "user_fact"` on any answer, which is the exact
 * laundering shape #206's attack list names ("the mapping seam laundering
 * policy/inference output into user_fact"). `persist.ts` was written to prevent
 * it and had zero production callers — it ran only in its own tests, so the
 * gate was real and unreachable, which is the same as absent.
 *
 * A gate below the thing it guards is not a gate (`prepare.ts`'s kind-gate
 * lesson, one layer up). So the seam moved to where the write is: this module
 * re-runs the whole pipeline server-side — resolve, fetch, parse, prepare, map
 * — from the application row and the user's RLS-scoped `answers` /
 * `answer_policies` rows. The client names an APPLICATION and an attachment
 * choice; every value, every source and every gap is derived here. There is no
 * parameter a caller could use to claim authorship, for the same reason there
 * is no `authoredBy` parameter anywhere in `lib/apply/` (`index.ts` says so in
 * bold).
 *
 * The pipeline is the one `/apply/[applicationId]/page.tsx` already performs,
 * and it is deliberately the same one: a Review surface that displays one
 * package while the write persists another is the drift this seam exists to
 * make impossible.
 *
 * The database is still the last word — `hq_autopilot_package_guard` re-judges
 * every answer for every writer, including this one. This module is what makes
 * the app layer's claim TRUE rather than what makes the rule enforceable.
 */
export type DeriveStagePackageResult =
  | { ok: true; package: StagePackage }
  /** The row is not this user's, or does not exist. RLS makes those one answer. */
  | { ok: false; kind: "missing"; message: string }
  /** Another ATS family, or a URL naming no board. Nothing to prepare against. */
  | { ok: false; kind: "not-preparable"; message: string }
  /** The board did not answer, or answered with no such job. */
  | { ok: false; kind: "fetch"; message: string }
  /** The board answered with something the parser cannot describe. */
  | { ok: false; kind: "parse"; message: string }
  /**
   * The engine produced something this half cannot persist honestly — an
   * inference answer, or a sensitive field whose backing row is not
   * server-stamped user-authored. Fail loud; never store a laundered source.
   */
  | { ok: false; kind: "mapping"; message: string };

export interface DeriveDeps {
  src: DataSource;
  /** Injectable for the reason `board-source.ts` is an interface at all. */
  boards?: BoardSource;
  /** Injected so a computed start date is testable against a pinned day. */
  today?: Date;
}

export async function deriveStagePackage(
  applicationId: number,
  deps: DeriveDeps,
): Promise<DeriveStagePackageResult> {
  const { src } = deps;
  const boards = deps.boards ?? getBoardSource();

  const applications = await src.applications();
  const application = applications.find((a) => a.id === applicationId);
  if (!application) {
    return { ok: false, kind: "missing", message: "No such application." };
  }

  const target = resolveApplyTarget({
    postingKey: application.postingKey,
    url: application.url,
  });
  if (target.kind !== "greenhouse") {
    return {
      ok: false,
      kind: "not-preparable",
      message: "This posting is not on a board this app can prepare against.",
    };
  }

  const fetched = await boards.form(target);
  if (!fetched.ok) {
    return { ok: false, kind: "fetch", message: fetched.message };
  }

  let form;
  try {
    form = parseGreenhouseForm(fetched.payload);
  } catch (err) {
    return {
      ok: false,
      kind: "parse",
      message:
        err instanceof Error ? err.message : "What came back was not a job posting.",
    };
  }

  // The user's OWN rows, read through the RLS-scoped source. `answers()`
  // selects `authored_by`, which is the column the whole mapping turns on:
  // omitting it would silently downgrade every sensitive row to a gap, and
  // ACCEPTING it from a caller would be the hole this module closes.
  const [answers, rules, jobs] = await Promise.all([
    src.answers(),
    src.policyRules(),
    src.jobs(),
  ]);
  const posting = application.postingKey
    ? jobs.find((j) => j.key === application.postingKey)
    : undefined;

  const engineAnswerRows = engineAnswers(answers);
  const engineRuleRows = engineRules(rules);

  const staged = prepareApplication({
    form,
    answers: engineAnswerRows,
    rules: engineRuleRows,
    companyKey: companyNameKey(application.company),
    postingCountry: posting?.country ?? undefined,
    // No `infer` hook, ever, in this half: layer 3 is structurally unreachable,
    // which is what makes `resume_evidence`/`drafted` unemittable rather than
    // merely unused.
    today: deps.today ?? (isDemoMode() ? new Date(FIXTURE_NOW) : undefined),
  });

  try {
    return {
      ok: true,
      package: toStagePackage(staged, {
        // THE SAME ROWS the prepare ran against — the mapper resolves each
        // field's source token back to its backing row to read the
        // server-stamped `authoredBy`, and refuses rather than guessing when a
        // token names a row that is not here.
        answers: engineAnswerRows,
        rules: engineRuleRows,
        companyKey: companyNameKey(application.company),
      }),
    };
  } catch (err) {
    if (err instanceof AutopilotMappingError) {
      return { ok: false, kind: "mapping", message: err.message };
    }
    throw err;
  }
}
