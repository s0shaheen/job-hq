"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section } from "../fields";
import { commitsImmediately, FactControl, sameFact, type FactDraft } from "./fact-controls";
import {
  deleteAnswerAction,
  deleteRuleAction,
  saveAnswerAction,
  saveRuleAction,
} from "@/lib/apply/actions";
import { APPLY_LIBRARY_LIMIT } from "@/lib/data/source";
import { ANSWER_KINDS, type AnswerView, type PolicyRuleView } from "@/lib/apply/views";
import {
  describeFact,
  isKnockout,
  kindLabel,
  TOPIC_SPECS,
  TOPICS_IN_ORDER,
  topicLabel,
} from "@/lib/apply/topics";
import type { Provenance, SituationFact } from "@/lib/apply/types";
import { blankTrim, companyNameKey } from "@/lib/data/view-models";
import { questionKey } from "@/lib/apply/normalize";
import { cn } from "@/lib/utils";

/**
 * The answer library and its rules, as a person edits them.
 *
 * Three sections, in the order the engine reads them: what is true about you
 * (layer 2), what you have already typed into a board (layer 1), and the places
 * where one company is different.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 *
 * 1. **A rule stores your SITUATION, never the word to submit.** Every control
 *    here asks about you — "do you need sponsorship?" — because one topic covers
 *    questions of opposite polarity and replaying a stored word against both
 *    submits its opposite half the time. That is not a nicety of wording: it is
 *    the bug this whole design exists to prevent.
 * 2. **Human and machine rows look different.** `authored_by` is the server's
 *    stamp and `provenance` is a claim, so a row a machine wrote says so and
 *    says what it is not allowed to answer.
 * 3. **Nothing here is filled in for you.** An unset rule stays unset; there is
 *    no "sensible default" for whether you need a visa.
 *
 * The write shape is the pipeline's, for its reasons: serialized writes so two
 * blurs milliseconds apart cannot conflict with each other (matrix row 115), a
 * ref written synchronously so the second read is not a stale token (row 134), a
 * bound so one hung request cannot freeze the surface (row 135), and one
 * idempotency key per gesture reused by its own Retry (row 136).
 */

/** How long one write may take before the surface stops waiting for it. */
const WRITE_TIMEOUT_MS = 15_000;

type Props = {
  answers: AnswerView[];
  rules: PolicyRuleView[];
};

/** One typed answer on its way to the library, with the scope it belongs at. */
type SaveAnswer = {
  question: string;
  answer: string;
  kind: string;
  /** A company NAME (or key — both normalize), `""` for every board. */
  company: string;
  declined?: boolean;
  provenance?: Provenance;
};

function ruleKeyOf(topic: string, companyKey: string): string {
  return `${topic}\u0000${companyKey}`;
}

/**
 * A library row's identity: the normalized question AND its scope (0017).
 *
 * The store's own key, mirrored here for the one job a surface needs it for —
 * finding the row a write is about. The previous version looked rows up by RAW
 * question text while the store keys them on the normalized form, so "Are you
 * 18" typed by hand over a stored "Are you 18?" found nothing, sent
 * `expectedUpdatedAt: null`, and overwrote the other row with no warning.
 */
function answerKeyOf(questionKeyValue: string, companyKey: string): string {
  return `${questionKeyValue}\u0000${companyKey}`;
}

function answerKeyOfView(a: AnswerView): string {
  return answerKeyOf(a.questionKey || questionKey(a.question), a.companyKey);
}

/** The testid and React key for a row — readable, and unique across both scopes. */
function answerIdOf(a: AnswerView): string {
  const key = a.questionKey || a.question;
  return a.companyKey === "" ? key : `${key}@${a.companyKey}`;
}

/** The rule that governs a topic globally, if any. */
function findRule(rules: PolicyRuleView[], topic: string, companyKey: string) {
  return rules.find((r) => r.topic === topic && r.companyKey === companyKey);
}

export function AnswersSurface({ answers: initialAnswers, rules: initialRules }: Props) {
  const [answers, setAnswers] = React.useState(initialAnswers);
  const [rules, setRules] = React.useState(initialRules);
  const [pending, setPending] = React.useState(0);
  const [writes, setWrites] = React.useState(0);
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  // Written SYNCHRONOUSLY, never from an effect: the queue advances on promise
  // callbacks (microtasks) and an effect is a macrotask, so a ref updated there
  // hands the next write a token from before the last one landed (matrix row 134).
  const answersRef = React.useRef(initialAnswers);
  const rulesRef = React.useRef(initialRules);
  const putAnswers = React.useCallback((next: AnswerView[]) => {
    answersRef.current = next;
    setAnswers(next);
  }, []);
  const putRules = React.useCallback((next: PolicyRuleView[]) => {
    rulesRef.current = next;
    setRules(next);
  }, []);

  const tail = React.useRef<Promise<unknown>>(Promise.resolve());

  /**
   * One write, after everything already queued.
   *
   * `send` is called when its TURN comes, not when it is queued, so it reads the
   * version token as it is by then.
   */
  const enqueue = React.useCallback(
    <T,>(send: () => Promise<T>, settle: (result: T | null) => void) => {
      setPending((n) => n + 1);
      const run = async () => {
        try {
          const result = await Promise.race([
            send(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), WRITE_TIMEOUT_MS)),
          ]);
          settle(result);
        } catch {
          settle(null);
        } finally {
          setPending((n) => n - 1);
          // Monotonic, and incremented for EVERY outcome including a refusal.
          // "Nothing is pending" is true before a write starts too, so a test
          // gated on quiet passes in the gap (matrix row 117).
          setWrites((n) => n + 1);
        }
      };
      const next = tail.current.then(run, run);
      tail.current = next.catch(() => undefined);
    },
    [],
  );

  const saveRule = React.useCallback(
    (
      topic: string,
      company: string,
      fact: SituationFact,
      opts: { note?: string; enabled?: boolean } = {},
      idem = crypto.randomUUID(),
    ) => {
      const companyKey = companyNameKey(company);
      const key = ruleKeyOf(topic, companyKey);
      const previous = findRule(rulesRef.current, topic, companyKey) ?? null;

      /**
       * The optimistic frame, applied synchronously.
       *
       * It never invents a version token: `updatedAt` is copied from the row it
       * replaces, so the write that follows still carries the last thing the
       * SERVER said. That is what makes it safe to read the token back out of
       * this array at send time (matrix row 134's rule, from the other side) —
       * and it is why a chained second write to the same rule does not conflict
       * with its own predecessor: by its turn, the first has settled on the
       * server's row.
       *
       * A toggle that does not move until a round trip lands reads as broken,
       * which is how people learn to click things twice.
       */
      const optimistic: PolicyRuleView = {
        topic,
        companyKey,
        fact,
        provenance: "user-entered",
        authoredBy: previous?.authoredBy ?? "user",
        note: opts.note ?? previous?.note ?? "",
        enabled: opts.enabled ?? previous?.enabled ?? true,
        updatedAt: previous?.updatedAt ?? null,
      };
      const revert = () => {
        const rest = rulesRef.current.filter((r) => ruleKeyOf(r.topic, r.companyKey) !== key);
        putRules(previous ? [...rest, previous] : rest);
      };
      putRules([
        ...rulesRef.current.filter((r) => ruleKeyOf(r.topic, r.companyKey) !== key),
        optimistic,
      ]);

      enqueue(
        () => {
          const before = findRule(rulesRef.current, topic, companyKey);
          return saveRuleAction({
            topic,
            company,
            fact,
            provenance: "user-entered",
            note: opts.note ?? before?.note ?? "",
            enabled: opts.enabled ?? before?.enabled ?? true,
            idempotencyKey: idem,
            expectedUpdatedAt: before?.updatedAt ?? null,
          });
        },
        (result) => {
          if (result === null) {
            revert();
            toast.error("That took too long. Try again, it will not save twice.", {
              action: {
                label: "Retry",
                onClick: () => saveRule(topic, company, fact, opts, idem),
              },
            });
            return;
          }
          if (result.ok) {
            // Settled on the SERVER's row, never on the optimistic one: the
            // token has moved and the next write needs the new one.
            const rest = rulesRef.current.filter((r) => ruleKeyOf(r.topic, r.companyKey) !== key);
            putRules([...rest, result.rule]);
            return;
          }
          if (result.kind === "conflict") {
            toast.warning("Changed on another device — showing the latest.");
            // The value that LOST must not stay on screen under a toast saying
            // somebody else's landed (matrix row 113). A conflict with no row
            // means it was deleted elsewhere, so the revert is the honest answer.
            const rest = rulesRef.current.filter((r) => ruleKeyOf(r.topic, r.companyKey) !== key);
            if (result.current) putRules([...rest, result.current]);
            else putRules(rest);
            return;
          }
          revert();
          if (result.kind === "auth") {
            toast.error("Couldn't save that — your session expired.", {
              description: "Sign in and try again.",
            });
            return;
          }
          toast.error("Couldn't save that.", {
            description: result.message,
            action: {
              label: "Retry",
              onClick: () => saveRule(topic, company, fact, opts, idem),
            },
          });
        },
      );
    },
    [enqueue, putRules],
  );

  const removeRule = React.useCallback(
    (topic: string, company: string, idem = crypto.randomUUID()) => {
      const companyKey = companyNameKey(company);
      enqueue(
        () => deleteRuleAction({ topic, company, idempotencyKey: idem }),
        (result) => {
          if (result === null) {
            toast.error("That took too long. Try again, it will not save twice.", {
              action: { label: "Retry", onClick: () => removeRule(topic, company, idem) },
            });
            return;
          }
          if (result.ok) {
            putRules(
              rulesRef.current.filter(
                (r) => ruleKeyOf(r.topic, r.companyKey) !== ruleKeyOf(topic, companyKey),
              ),
            );
            return;
          }
          if (result.kind === "auth") {
            toast.error("Couldn't remove that — your session expired.", {
              description: "Sign in and try again.",
            });
            return;
          }
          toast.error("Couldn't remove that.", { description: result.message });
        },
      );
    },
    [enqueue, putRules],
  );

  const saveAnswer = React.useCallback(
    (input: SaveAnswer, idem = crypto.randomUUID(), onSaved?: () => void) => {
      const scope = answerKeyOf(questionKey(input.question), companyNameKey(input.company));
      enqueue(
        () => {
          // Located by the row's IDENTITY — the normalized key AND the scope —
          // never by the raw text somebody typed. Looking it up by raw question
          // meant "Are you 18" and "Are you 18?" were two different rows to this
          // surface and one row to the store, so an add-by-hand sent
          // `expectedUpdatedAt: null` and silently overwrote the existing answer.
          const before = answersRef.current.find((a) => answerKeyOfView(a) === scope);
          return saveAnswerAction({
            question: input.question,
            answer: input.answer,
            kind: input.kind,
            company: input.company,
            declined: input.declined ?? false,
            provenance: input.provenance ?? "user-entered",
            idempotencyKey: idem,
            expectedUpdatedAt: before?.updatedAt ?? null,
          });
        },
        (result) => {
          if (result === null) {
            toast.error("That took too long. Try again, it will not save twice.", {
              action: { label: "Retry", onClick: () => saveAnswer(input, idem, onSaved) },
            });
            return;
          }
          if (result.ok) {
            const rest = answersRef.current.filter(
              (a) => answerKeyOfView(a) !== answerKeyOfView(result.answer),
            );
            putAnswers([...rest, result.answer]);
            onSaved?.();
            return;
          }
          if (result.kind === "conflict") {
            toast.warning("Changed on another device — showing the latest.");
            if (result.current) {
              const fresh = result.current;
              const rest = answersRef.current.filter(
                (a) => answerKeyOfView(a) !== answerKeyOfView(fresh),
              );
              putAnswers([...rest, fresh]);
            }
            return;
          }
          if (result.kind === "auth") {
            toast.error("Couldn't save that — your session expired.", {
              description: "Sign in and try again.",
            });
            return;
          }
          toast.error("Couldn't save that.", {
            description: result.message,
            action: { label: "Retry", onClick: () => saveAnswer(input, idem, onSaved) },
          });
        },
      );
    },
    [enqueue, putAnswers],
  );

  const removeAnswer = React.useCallback(
    (view: AnswerView, idem = crypto.randomUUID()) => {
      enqueue(
        () =>
          deleteAnswerAction({
            question: view.question,
            company: view.companyKey,
            idempotencyKey: idem,
          }),
        (result) => {
          if (result === null) {
            toast.error("That took too long. Try again, it will not save twice.", {
              action: { label: "Retry", onClick: () => removeAnswer(view, idem) },
            });
            return;
          }
          if (result.ok) {
            putAnswers(
              answersRef.current.filter((a) => answerKeyOfView(a) !== answerKeyOfView(view)),
            );
            return;
          }
          if (result.kind === "auth") {
            toast.error("Couldn't remove that — your session expired.", {
              description: "Sign in and try again.",
            });
            return;
          }
          toast.error("Couldn't remove that.", { description: result.message });
        },
      );
    },
    [enqueue, putAnswers],
  );

  const globalRules = React.useMemo(() => rules.filter((r) => r.companyKey === ""), [rules]);
  const exceptions = React.useMemo(
    () =>
      [...rules.filter((r) => r.companyKey !== "")].sort(
        (a, b) => a.companyKey.localeCompare(b.companyKey) || a.topic.localeCompare(b.topic),
      ),
    [rules],
  );
  // Question first, then scope, so a question's two answers sit together and the
  // global one comes first — the order the engine reads them in is the reverse,
  // and the order a person scans them in is this one.
  const sortedAnswers = React.useMemo(
    () =>
      [...answers].sort(
        (a, b) => a.question.localeCompare(b.question) || a.companyKey.localeCompare(b.companyKey),
      ),
    [answers],
  );
  // A rule whose fact is unreadable counts as UNSET here, because that is what
  // it is to an application: `engineRules` drops it and every question it would
  // have answered gaps. Counting it as set would put a number on screen that
  // disagrees with what the review surface then shows.
  const unsetKnockouts = TOPICS_IN_ORDER.filter(
    (t) => isKnockout(t) && !findRule(globalRules, t, "")?.fact,
  );

  return (
    <div
      className="mx-auto max-w-2xl space-y-3 px-4 pt-5 pb-40 sm:px-6"
      data-testid="answers-surface"
      data-hydrated={hydrated ? "true" : "false"}
      data-saving={pending > 0 ? "true" : "false"}
      data-writes={writes}
      data-unset-knockouts={unsetKnockouts.length}
    >
      {pending > 0 ? (
        <p role="status" aria-live="polite" className="text-xs text-muted">
          Saving…
        </p>
      ) : null}

      <Section
        id="situation"
        title="Your situation"
        blurb={
          <>
            These are questions about you, not about a job, so a board asking any of them in
            any wording gets the same answer. We store what is true and work out the answer
            when the question is read — which is how one answer covers “do you need
            sponsorship?” and “can you work without sponsorship?” without being wrong about
            one of them.
          </>
        }
      >
        <div className="space-y-2">
          {unsetKnockouts.length > 0 ? (
            <p className="rounded-md border border-warn bg-surface p-2 text-xs text-text-2" role="status">
              {unsetKnockouts.length} of these end an application if answered wrong and have
              no rule yet. Nothing will guess them: every board that asks one stops and waits
              for you.
            </p>
          ) : null}
          {TOPICS_IN_ORDER.filter((t) => isKnockout(t)).map((topic) => (
            <TopicRow
              key={topic}
              topic={topic}
              rule={findRule(globalRules, topic, "") ?? null}
              onSave={(fact) => saveRule(topic, "", fact)}
              onRemove={() => removeRule(topic, "")}
            />
          ))}

          {/* The seven above end an application when they are wrong; the nine
              below shrink one. Same controls, one disclosure, so the page opens
              on the questions that matter rather than on sixteen equal cards —
              the onboarding overhaul's "More filters" shape, for its reason. */}
          <details className="rounded-md border border-border" data-testid="more-topics">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              The rest of what a form asks
              <span className="ml-1 text-xs font-normal text-muted">
                — start date, relocation, how you heard about the job
              </span>
            </summary>
            <div className="space-y-2 border-t border-border p-2">
              {TOPICS_IN_ORDER.filter((t) => !isKnockout(t)).map((topic) => (
                <TopicRow
                  key={topic}
                  topic={topic}
                  rule={findRule(globalRules, topic, "") ?? null}
                  onSave={(fact) => saveRule(topic, "", fact)}
                  onRemove={() => removeRule(topic, "")}
                />
              ))}
            </div>
          </details>
        </div>
      </Section>

      <Section
        id="library"
        title="Saved answers"
        blurb={
          <>
            Everything you have typed into a board once. A question worded the same way on
            another board is filled in from here — punctuation and capitals do not count, so
            “Are you 18?” and “ARE YOU 18” are one answer. Some of these apply at one company
            only, and say so; a rule under Your situation still wins at the company it names.
          </>
        }
      >
        <AnswerLibrary answers={sortedAnswers} onSave={saveAnswer} onRemove={removeAnswer} />
      </Section>

      <Section
        id="exceptions"
        title="Company exceptions"
        blurb={
          <>
            One company where the truth is different — you did work there, somebody there
            referred you. An exception wins over the rule above it, and turning one off puts
            the general rule back rather than leaving the question unanswered.
          </>
        }
      >
        <Exceptions
          rules={exceptions}
          onSave={(topic, company, fact, opts) => saveRule(topic, company, fact, opts)}
          onRemove={(topic, company) => removeRule(topic, company)}
        />
      </Section>
    </div>
  );
}

/** One topic: what it asks, what is stored, and the control to change it. */
function TopicRow({
  topic,
  rule,
  onSave,
  onRemove,
}: {
  topic: string;
  rule: PolicyRuleView | null;
  onSave: (fact: SituationFact) => void;
  onRemove: () => void;
}) {
  const spec = TOPIC_SPECS[topic as keyof typeof TOPIC_SPECS];
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<FactDraft>(rule?.fact ?? null);

  // Re-seed from the server's row when it changes underneath (a conflict, a
  // reload). One effect per field, and this component has exactly one.
  React.useEffect(() => {
    setDraft(rule?.fact ?? null);
  }, [rule?.fact]);

  const stored = rule?.fact ?? null;
  /** A rule EXISTS and this build cannot read it — not the same as no rule. */
  const unreadable = rule !== null && rule.fact === null;
  const dirty = !sameFact(draft, stored);
  const immediate = commitsImmediately(spec.field);

  function change(next: FactDraft) {
    setDraft(next);
    if (immediate && next !== null && !sameFact(next, stored)) onSave(next);
  }

  return (
    <div
      className="rounded-md border border-border p-3"
      data-testid={`topic-${topic}`}
      // "Set" means "answers something". A rule whose fact nothing can read is
      // present in the table and absent from every application, and calling that
      // set would be the surface telling the same lie the engine refuses to.
      data-set={stored !== null ? "true" : "false"}
      data-unreadable={unreadable ? "true" : "false"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{spec.label}</p>
          <p className="text-xs text-muted">{spec.question}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isKnockout(topic) ? (
            <Badge tone="warn" className="whitespace-nowrap">
              Ends an application if wrong
            </Badge>
          ) : null}
          {rule && !rule.enabled ? <Badge tone="neutral">Off</Badge> : null}
        </div>
      </div>

      <p className="mt-2 text-sm" data-testid={`topic-${topic}-value`}>
        {/* Unreadable is checked FIRST. Both states have a null fact, so a
            `stored === null` branch above this one swallows it — which is
            precisely what the first version did, leaving a rule that exists and
            answers nothing indistinguishable from no rule at all. */}
        {unreadable ? (
          <span className="text-warn">
            Stored in a shape this app cannot read, so it answers nothing. Set it again to
            replace it.
          </span>
        ) : stored === null ? (
          <span className="text-muted">Not set — every board that asks this waits for you.</span>
        ) : (
          <span className="font-medium">{describeFact(stored)}</span>
        )}
      </p>

      {open ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <FactControl
            idPrefix={`topic-${topic}`}
            field={spec.field}
            draft={draft}
            disabled={false}
            onChange={change}
          />
          {spec.help ? <p className="text-xs text-muted">{spec.help}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            {!immediate ? (
              <Button
                type="button"
                size="sm"
                variant="primary"
                data-testid={`topic-${topic}-save`}
                disabled={!dirty || draft === null}
                onClick={() => draft && onSave(draft)}
              >
                Save
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(stored);
                setOpen(false);
              }}
            >
              Close
            </Button>
            {stored !== null ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid={`topic-${topic}-remove`}
                onClick={onRemove}
              >
                Remove this rule
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          className="mt-2"
          data-testid={`topic-${topic}-edit`}
          onClick={() => setOpen(true)}
        >
          {stored === null ? "Answer this" : "Change"}
        </Button>
      )}
    </div>
  );
}

/**
 * The library.
 *
 * A row a MACHINE wrote is rendered differently from one you wrote, and says
 * what it is not allowed to answer — `authored_by` is the server's stamp and is
 * what every knockout gate reads, while `provenance` is only a claim about how
 * the text was produced.
 */
function AnswerLibrary({
  answers,
  onSave,
  onRemove,
}: {
  answers: AnswerView[];
  onSave: (input: SaveAnswer, idem?: string, onSaved?: () => void) => void;
  onRemove: (answer: AnswerView) => void;
}) {
  const atCeiling = answers.length >= APPLY_LIBRARY_LIMIT;
  return (
    <div className="space-y-2">
      {atCeiling ? (
        <p className="rounded-md border border-warn bg-surface p-2 text-xs text-text-2" role="status">
          This page reads the first {APPLY_LIBRARY_LIMIT} answers. You are at that number, so
          anything past it is stored and not read — including when an application is prepared.
        </p>
      ) : null}

      {answers.length === 0 ? (
        <p className="text-sm text-muted" data-testid="library-empty">
          Nothing saved yet. Answer a question while reviewing an application and it lands
          here, worded exactly as the board asked it.
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="library-list">
          {answers.map((a) => (
            // Keyed by question AND scope. One question can hold two answers now
            // — one for every board and one for a single company — and a key that
            // is only the question makes them one row to React and two to the
            // store.
            <AnswerRow key={answerIdOf(a)} answer={a} onSave={onSave} onRemove={onRemove} />
          ))}
        </ul>
      )}

      <AddAnswer
        onSave={onSave}
        existing={(question, company) =>
          answers.find(
            (a) => answerKeyOfView(a) === answerKeyOf(questionKey(question), companyNameKey(company)),
          )
        }
      />

      <p className="text-xs text-muted">
        Removing an answer here leaves the question unanswered rather than answered wrong: the
        next board that asks it waits for you again.
      </p>
    </div>
  );
}

function AnswerRow({
  answer,
  onSave,
  onRemove,
}: {
  answer: AnswerView;
  onSave: (input: SaveAnswer, idem?: string, onSaved?: () => void) => void;
  onRemove: (answer: AnswerView) => void;
}) {
  const [draft, setDraft] = React.useState(answer.answer);
  React.useEffect(() => setDraft(answer.answer), [answer.answer]);
  const machine = answer.authoredBy !== "user";
  const unconfirmed = answer.provenance === "suggested";
  const key = answerIdOf(answer);

  return (
    <li
      className="py-2"
      data-testid={`answer-${key}`}
      data-scope={answer.companyKey}
      data-declined={answer.declined ? "true" : "false"}
    >
      <p className="text-sm font-medium">{answer.question}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge
          tone={machine || unconfirmed ? "warn" : "neutral"}
          data-testid={`answer-${key}-provenance`}
        >
          {machine
            ? "Written by the app"
            : answer.declined
              ? "You chose not to answer"
              : answer.provenance === "confirmed"
                ? "You confirmed this"
                : "You wrote this"}
        </Badge>
        {/* WHERE it applies. A one-company answer that looked identical to a
            global one is how somebody would fix the wrong row. */}
        {answer.companyKey === "" ? null : (
          <Badge tone="neutral" data-testid={`answer-${key}-scope`}>
            Only at {answer.companyKey}
          </Badge>
        )}
        <span className="text-2xs text-muted">{kindLabel(answer.kind)}</span>
      </div>
      {machine ? (
        <p className="mt-1 text-xs text-muted">
          Not used on work authorization, pay, background or self-identification questions —
          those take an answer only when you wrote it yourself, on that exact question.
        </p>
      ) : null}
      {answer.declined ? (
        <p className="mt-1 text-xs text-muted">
          Boards that offer the same choice get it. Editing the box below replaces the refusal
          with an answer; Remove leaves the question unanswered.
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`answer-${key}-input`} className="sr-only">
            Answer to {answer.question}
          </label>
          <input
            id={`answer-${key}-input`}
            data-testid={`answer-${key}-input`}
            type="text"
            value={draft}
            maxLength={8000}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="primary"
          data-testid={`answer-${key}-save`}
          disabled={blankTrim(draft) === "" || draft === answer.answer}
          // Saving a machine's text unchanged is `confirmed` — you looked at it
          // and said yes, which is a different fact from having typed it.
          //
          // The scope RIDES ALONG unchanged. Editing a Stripe-only answer must
          // not quietly promote it to every board, which is the M1 bug arriving
          // through a different door.
          onClick={() =>
            onSave({
              question: answer.question,
              answer: draft,
              kind: answer.kind,
              company: answer.companyKey,
              // Typing over a refusal replaces it with an answer. Keeping the
              // flag would file what they just wrote as a decline.
              declined: false,
              provenance: machine ? "confirmed" : "user-entered",
            })
          }
        >
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid={`answer-${key}-remove`}
          onClick={() => onRemove(answer)}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

function AddAnswer({
  onSave,
  existing,
}: {
  onSave: (input: SaveAnswer, idem?: string, onSaved?: () => void) => void;
  /** The row this question and scope already resolve to, if any. */
  existing: (question: string, company: string) => AnswerView | undefined;
}) {
  const [question, setQuestion] = React.useState("");
  const [value, setValue] = React.useState("");
  const [kind, setKind] = React.useState<string>("freeform");
  const [company, setCompany] = React.useState("");
  const ready = blankTrim(question) !== "" && blankTrim(value) !== "";
  /**
   * The row this is about to become, if there already is one.
   *
   * Resolved by the STORE's identity — normalized question plus scope — because
   * that is what decides which row a write lands on. "Are you 18" typed over a
   * stored "Are you 18?" is the same row, and saying so is the difference between
   * an overwrite somebody chose and one they discovered.
   */
  const collides = ready ? existing(question.trim(), company) : undefined;

  return (
    <div className="rounded-md border border-dashed border-border-strong p-3">
      <p className="text-xs font-medium text-text-2">Add one by hand</p>
      <div className="mt-2 space-y-2">
        <div>
          <label htmlFor="add-answer-question" className="block text-xs text-muted">
            The question, worded the way the board words it
          </label>
          <input
            id="add-answer-question"
            data-testid="add-answer-question"
            value={question}
            maxLength={2000}
            onChange={(e) => setQuestion(e.target.value)}
            className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label htmlFor="add-answer-value" className="block text-xs text-muted">
            Your answer
          </label>
          <input
            id="add-answer-value"
            data-testid="add-answer-value"
            value={value}
            maxLength={8000}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="add-answer-kind" className="block text-xs text-muted">
              What it is
            </label>
            <select
              id="add-answer-kind"
              data-testid="add-answer-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="mt-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
            >
              {ANSWER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
          </div>
          {/* Blank means every board. Here rather than as a checkbox, because
              there is no application on this screen to name the company for you. */}
          <div className="min-w-0 grow basis-40">
            <label htmlFor="add-answer-company" className="block text-xs text-muted">
              Only at (optional)
            </label>
            <input
              id="add-answer-company"
              data-testid="add-answer-company"
              value={company}
              maxLength={200}
              onChange={(e) => setCompany(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="primary"
            data-testid="add-answer-save"
            disabled={!ready}
            onClick={() =>
              onSave(
                {
                  question: question.trim(),
                  answer: value,
                  kind,
                  company,
                  provenance: "user-entered",
                },
                crypto.randomUUID(),
                () => {
                  setQuestion("");
                  setValue("");
                  setCompany("");
                },
              )
            }
          >
            {collides ? "Replace answer" : "Save answer"}
          </Button>
        </div>
        {collides ? (
          <p className="text-xs text-warn" data-testid="add-answer-collision" role="status">
            This replaces your saved answer to “{collides.question}”
            {collides.companyKey === "" ? "" : ` at ${collides.companyKey}`} — punctuation and
            capitals do not make a second answer.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Exceptions({
  rules,
  onSave,
  onRemove,
}: {
  rules: PolicyRuleView[];
  onSave: (
    topic: string,
    company: string,
    fact: SituationFact,
    opts?: { note?: string; enabled?: boolean },
  ) => void;
  onRemove: (topic: string, company: string) => void;
}) {
  const [topic, setTopic] = React.useState<string>(TOPICS_IN_ORDER[0]);
  const [company, setCompany] = React.useState("");
  const [draft, setDraft] = React.useState<FactDraft>(null);
  const spec = TOPIC_SPECS[topic as keyof typeof TOPIC_SPECS];

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <p className="text-sm text-muted" data-testid="exceptions-empty">
          None. Every company gets the answers above.
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="exceptions-list">
          {rules.map((r) => (
            <li
              key={`${r.topic}-${r.companyKey}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid={`exception-${r.topic}-${r.companyKey}`}
            >
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-medium">{r.companyKey}</span>
                  <span className="text-muted"> — {topicLabel(r.topic)}</span>
                </p>
                <p className={cn("text-xs", r.enabled ? "text-text-2" : "text-muted line-through")}>
                  {describeFact(r.fact)}
                </p>
                {r.note ? <p className="text-2xs text-muted">{r.note}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-muted">
                  <input
                    type="checkbox"
                    data-testid={`exception-${r.topic}-${r.companyKey}-enabled`}
                    checked={r.enabled}
                    disabled={r.fact === null}
                    onChange={(e) =>
                      r.fact && onSave(r.topic, r.companyKey, r.fact, { enabled: e.target.checked })
                    }
                  />
                  On
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`exception-${r.topic}-${r.companyKey}-remove`}
                  onClick={() => onRemove(r.topic, r.companyKey)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-md border border-dashed border-border-strong p-3">
        <p className="text-xs font-medium text-text-2">Add an exception</p>
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            <div>
              <label htmlFor="exception-topic" className="block text-xs text-muted">
                Question
              </label>
              <select
                id="exception-topic"
                data-testid="exception-topic"
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value);
                  setDraft(null);
                }}
                className="mt-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
              >
                {TOPICS_IN_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {topicLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            {/* `basis-48 grow`, not `flex-1`: on a phone the topic select is
                already ~200px wide, and a company box sharing that row is a
                two-word slot. This wraps to its own line instead. */}
            <div className="min-w-0 grow basis-48">
              <label htmlFor="exception-company" className="block text-xs text-muted">
                Company
              </label>
              <input
                id="exception-company"
                data-testid="exception-company"
                value={company}
                maxLength={200}
                onChange={(e) => setCompany(e.target.value)}
                className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-muted">{spec.question}</p>
          <FactControl
            idPrefix="exception"
            field={spec.field}
            draft={draft}
            disabled={false}
            onChange={setDraft}
          />
          <Button
            type="button"
            size="sm"
            variant="primary"
            data-testid="exception-save"
            disabled={draft === null || companyNameKey(company) === ""}
            onClick={() => {
              if (!draft) return;
              onSave(topic, company, draft);
              setCompany("");
              setDraft(null);
            }}
          >
            Save exception
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted">
        <Link href="/settings" className="underline">
          Back to your search profile
        </Link>
      </p>
    </div>
  );
}
