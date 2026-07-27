"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { saveAnswerAction } from "@/lib/apply/actions";
import { classifyTopic, isCompanyVaryingTopic } from "@/lib/apply/policy";
import { blankTrim } from "@/lib/data/view-models";
import {
  describeSource,
  GAP_COPY,
  kindForField,
  layerLabel,
  topicLabel,
} from "@/lib/apply/topics";
import type { FormField, StagedApplication, StagedField } from "@/lib/apply/types";

/**
 * One staged application, read by a person.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE FOUR THINGS THIS SCREEN MAY NOT DO
 *
 * `webapp/lib/apply/index.ts` states them and they are load-bearing here:
 *
 *   1. **Never fill a gap on the user's behalf.** Every gap control opens with
 *      nothing selected. There is no "accept all", and there is deliberately no
 *      affordance that could reach a knockout question in bulk.
 *   2. **Never pick “I don't wish to answer”.** It is OFFERED, on the
 *      self-identification questions that carry it, because declining is a
 *      choice a person makes. Nothing here makes it for them — and when they DO
 *      make it, it is saved as a refusal (`declined`) rather than as the option's
 *      words, because a stored label no layer may select is a question that comes
 *      back forever under copy telling them to pick one of the board's options.
 *   3. **`batchApprovable` is an opinion, not permission.** It answers "could a
 *      human approve this in one keystroke?" and never "may this be submitted
 *      without one". Nothing on this screen submits, and the banner says so in
 *      the same breath as the green state.
 *   4. **Save what the human types back to the library, at a SCOPE.** The first
 *      half is the growth loop — "every novel question answered once becomes a
 *      constant" — and the only thing that makes the second application cheaper
 *      than the first. The second half is what an adversarial review broke: the
 *      engine reads the library before the rules, so an answer saved for every
 *      board overrules an exception the person scoped to one company. The
 *      checkbox on each card is that scope, and it opens narrow for the topics
 *      `isCompanyVaryingTopic` names.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A GAP IS A QUESTION, NOT AN ERROR
 *
 * Gaps are rendered first and rendered as work: the title says what is missing,
 * the body says why nothing guessed it, and where an answer can close it there is
 * a box right there. `GAP_COPY` is `Record<GapReason, …>`, so a reason added to
 * the engine is a compile error rather than a blank card.
 *
 * And the polarity is always shown beside a rule-sourced value. `prepare.ts`
 * stamps `policy:<topic>[@<company>]/<direction>` precisely so a person can catch
 * the engine reading a question backwards; showing the topic alone is what made
 * that bug invisible for a whole build.
 */

/** How long one write may take before the surface stops waiting for it. */
const WRITE_TIMEOUT_MS = 15_000;

/** One typed gap answer, on its way to the library. */
type SaveGap = {
  question: string;
  answer: string;
  kind: string;
  /** `""` saves it for every board; a company NAME saves it here only. */
  company: string;
  /** The chosen option is the board's own "I don't wish to answer". */
  declined: boolean;
};

type Props = {
  staged: StagedApplication;
  company: string;
  title: string;
  boardUrl: string;
};

export function ReviewSurface({ staged, company, title, boardUrl }: Props) {
  const router = useRouter();
  const [pending, setPending] = React.useState(0);
  const [writes, setWrites] = React.useState(0);
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  const tail = React.useRef<Promise<unknown>>(Promise.resolve());

  const saveAnswer = React.useCallback(
    (input: SaveGap, idem = crypto.randomUUID()) => {
      setPending((n) => n + 1);
      const run = async () => {
        try {
          const result = await Promise.race([
            saveAnswerAction({
              question: input.question,
              answer: input.answer,
              kind: input.kind,
              // WHERE it applies. The scope is the person's choice on the card,
              // and it is the difference between "answered once" and "answered
              // wrong everywhere": a library answer outranks a global rule, so a
              // company-varying fact saved globally overrules the exception they
              // set themselves.
              company: input.company,
              // They picked the board's own "I don't wish to answer". Recorded as
              // the choice it is, so the next board offering one gets it rather
              // than reporting the question unanswerable forever.
              declined: input.declined,
              // Typed by a person, on this screen, in answer to this question.
              // `authored_by` is not sent — the trigger stamps it, which is what
              // makes this row usable on a knockout field at all.
              provenance: "user-entered",
              idempotencyKey: idem,
              expectedUpdatedAt: null,
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), WRITE_TIMEOUT_MS)),
          ]);
          if (result === null) {
            toast.error("That took too long. Try again, it will not save twice.", {
              action: { label: "Retry", onClick: () => saveAnswer(input, idem) },
            });
            return;
          }
          if (result.ok) {
            toast.success(
              input.company === ""
                ? "Saved. Any board that asks this in the same words gets it."
                : `Saved for ${input.company}. Other companies keep the answer you had.`,
            );
            // Re-render the SERVER component: the staged application is derived
            // from the library, so the field this answer closes has to be
            // re-resolved by the engine rather than patched on screen. A local
            // patch here would be the surface inventing a resolution.
            router.refresh();
            return;
          }
          if (result.kind === "conflict") {
            toast.warning("You answered this on another device — showing the latest.");
            router.refresh();
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
            action: { label: "Retry", onClick: () => saveAnswer(input, idem) },
          });
        } finally {
          setPending((n) => n - 1);
          setWrites((n) => n + 1);
        }
      };
      const next = tail.current.then(run, run);
      tail.current = next.catch(() => undefined);
    },
    [router],
  );

  const gaps = staged.fields.filter((f) => f.gap !== null);
  const filled = staged.fields.filter((f) => f.gap === null);
  // The parsed field beside the staged one: `StagedField` deliberately carries
  // no options (it is the resolver's answer, not the form's shape), and a gap
  // control has to offer the board's own options rather than a text box that
  // stores something the board would refuse.
  const byName = new Map(staged.form.fields.map((f) => [f.name, f]));
  const c = staged.coverage;
  const attachmentGaps = gaps.filter((f) => f.gap === "attachment");

  return (
    <div
      className="mx-auto max-w-3xl space-y-3 px-4 pt-5 pb-40 sm:px-6"
      data-testid="apply-surface"
      data-hydrated={hydrated ? "true" : "false"}
      data-saving={pending > 0 ? "true" : "false"}
      data-writes={writes}
      data-readiness={staged.readiness}
      data-batch-approvable={staged.batchApprovable ? "true" : "false"}
      data-total={c.total}
      data-answered={c.answered}
      data-gaps={c.gaps}
      data-blocking-gaps={c.blockingGaps}
    >
      {pending > 0 ? (
        <p role="status" aria-live="polite" className="text-xs text-muted">
          Saving…
        </p>
      ) : null}

      <Readiness staged={staged} hasAttachmentGap={attachmentGaps.length > 0} />

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">
          {gaps.length === 0 ? "Nothing left to answer" : `${gaps.length} to answer`}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {gaps.length === 0
            ? "Every question on this form has an answer from something you wrote or a rule you set."
            : "Each of these is a question, not an error. Nothing was guessed into any of them."}
          {gaps.length > 0 && company.trim() !== "" ? (
            <>
              {" "}
              An answer you type is saved for every board that asks it in the same words —
              tick “Only at {company}” to keep it here instead.
            </>
          ) : null}
        </p>
        <ul className="mt-3 space-y-2" data-testid="gap-list">
          {gaps.map((f) => (
            <GapCard
              key={f.name}
              field={f}
              source={byName.get(f.name)}
              company={company}
              onSave={saveAnswer}
            />
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">{filled.length} filled in</h2>
        <p className="mt-1 text-sm text-muted">
          Where each answer comes from, including which way round we read the question.
        </p>
        <ul className="mt-3 divide-y divide-border" data-testid="filled-list">
          {filled.map((f) => (
            <FilledRow key={f.name} field={f} source={byName.get(f.name)} />
          ))}
        </ul>
      </section>

      <p className="text-xs text-muted">
        {company} — {title}.{" "}
        {/* A link with no URL is a link back to this page, which is what
            `href=""` renders as — reachable whenever the payload carries no
            `absolute_url` and the row has none either. Plain text instead. */}
        {boardUrl === "" ? (
          "This posting carries no link, so the board has to be found by hand."
        ) : (
          <>
            <Link href={boardUrl} target="_blank" rel="noopener noreferrer" className="underline">
              Open the board
            </Link>{" "}
            to fill it in.
          </>
        )}{" "}
        Nothing here is sent anywhere: this app has no way to submit an application, and the
        answers above are here so you can copy them without hunting for each one.
      </p>
    </div>
  );
}

/**
 * The honesty banner.
 *
 * The three states say different things, and the `ready` one is the sentence
 * this whole unit is judged on: it names the opinion AND says what it is not.
 */
function Readiness({
  staged,
  hasAttachmentGap,
}: {
  staged: StagedApplication;
  hasAttachmentGap: boolean;
}) {
  const c = staged.coverage;
  const tone =
    staged.readiness === "ready" ? "ok" : staged.readiness === "blocked" ? "danger" : "warn";
  return (
    <section
      className="rounded-lg border border-border bg-surface p-4"
      data-testid="readiness-banner"
      aria-labelledby="readiness-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>
          {staged.readiness === "ready"
            ? "Ready to approve"
            : staged.readiness === "blocked"
              ? "Not submittable"
              : "Wants a look"}
        </Badge>
        <h2 id="readiness-heading" className="text-sm font-semibold">
          {c.answered} of {c.total} answered
        </h2>
        <span className="text-xs text-muted">
          {c.needsReview > 0 ? `${c.needsReview} suggested · ` : ""}
          {c.gaps} unanswered
          {c.blockingGaps > 0 ? ` (${c.blockingGaps} required)` : ""}
        </span>
      </div>

      <p className="mt-2 text-sm text-text-2">
        {staged.readiness === "ready" ? (
          <>
            Every field here came from something you wrote or a rule you set — no guesses and
            nothing to draft. That is an opinion about this form, <strong>not permission to
            send it</strong>: nothing in this app submits an application, and the approve-and-go
            step is not built.
          </>
        ) : staged.readiness === "blocked" ? (
          <>
            {c.blockingGaps} required {c.blockingGaps === 1 ? "question has" : "questions have"} no
            answer, so this form cannot be completed as it stands.
          </>
        ) : (
          <>
            Nothing here blocks the form. Some of it was proposed rather than typed by you, so it
            is worth a read before you use it.
          </>
        )}
      </p>

      {hasAttachmentGap ? (
        <p className="mt-2 text-xs text-warn" data-testid="attachment-note">
          This form asks for a résumé and nothing here attaches one. That is why no real
          Greenhouse posting reaches “ready” yet — every one of them asks — and excusing the
          file from the count would buy a green card that cannot be submitted.
        </p>
      ) : null}

      {staged.form.unsupportedBlocks.length > 0 ? (
        <p className="mt-2 text-xs text-warn" data-testid="unsupported-blocks">
          This posting carries a block this app has never seen (
          {staged.form.unsupportedBlocks.join(", ")}), so something on the real page will be
          asked that nothing here has read.
        </p>
      ) : null}
    </section>
  );
}

/** One gap: what is missing, why nothing guessed it, and a box when one helps. */
function GapCard({
  field,
  source,
  company,
  onSave,
}: {
  field: StagedField;
  /** The parsed form field, for its options and its demographic flag. */
  source: FormField | undefined;
  /** The company this application is to, for the scope control. */
  company: string;
  onSave: (input: SaveGap) => void;
}) {
  const reason = field.gap ?? "no-answer";
  const copy = GAP_COPY[reason];
  /**
   * The draft is the option's INDEX, not its label.
   *
   * Board content is third-party, so two options can share a label ("Yes"
   * twice, with different ids) and two can share a value. Keying and valuing on
   * the label made those two indistinguishable to the select and produced
   * duplicate React keys; the index is unique by construction and resolves back
   * to the option on save.
   */
  const [draft, setDraft] = React.useState("");
  const match = classifyTopic(field.label);
  const topic = match.kind === "topic" ? match.topic : null;
  const kind = kindForField({
    selfIdentification: source?.selfIdentification ?? false,
    topic,
  });
  // Every option the board offers, INCLUDING the one marked "I don't wish to
  // answer". It is offered because declining is a choice; nothing here makes it.
  const options = source?.options ?? [];
  /**
   * The option the person picked, or `undefined` while they have not.
   *
   * The `draft === ""` arm is load-bearing and its absence was worse than the bug
   * it replaced: `Number("")` is 0, so `chosen` was `options[0]` before any
   * interaction, `disabled` was false, and one click on a freshly rendered card
   * wrote the board's FIRST option into the library — a knockout answer, an EEO
   * answer, or (on a board that lists its decline first) a refusal, none of them
   * chosen by anybody, and all of them through the growth loop that then replays
   * it on every board wording the question the same way.
   *
   * The select itself was always correct: it opens on `value === ""`. This is the
   * read-back, and "nothing selected" has to survive it.
   */
  const chosen = draft === "" ? undefined : options[Number(draft)];

  /**
   * Which SCOPE this answer is saved at, and why it opens where it does.
   *
   * The control exists because a library answer outranks a global rule, so a
   * fact that differs per employer — pay expectations, "have you worked here
   * before", who referred you — typed once at one board became the answer at
   * every board, over the top of an exception the person had set deliberately.
   *
   * It opens CHECKED for exactly the topics whose truth is known to vary
   * (`COMPANY_VARYING_TOPICS`), and that is not "filling in a gap on somebody's
   * behalf": it decides where an answer is filed, never what the answer is, and
   * the narrow scope is the one that cannot be wrong somewhere else.
   */
  const scoped = topic !== null && isCompanyVaryingTopic(topic);
  const [onlyHere, setOnlyHere] = React.useState(scoped);
  const canScope = company.trim() !== "";

  return (
    <li
      className="rounded-md border border-border p-3"
      data-testid={`gap-${field.name}`}
      data-reason={reason}
      data-required={field.required ? "true" : "false"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm font-medium">{field.label}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {field.required ? <Badge tone="danger">Required</Badge> : null}
          <Badge tone="neutral">{copy.title}</Badge>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">{copy.body}</p>

      {/* Greenhouse's "Resume/CV" is ONE question offering an upload and a paste
          box, and filling either satisfies it on the board. `prepare.ts` stages
          fields rather than questions, so it counts as two gaps — said here
          rather than collapsed, because the count and the coverage numbers have
          to agree with each other. */}
      {(source?.siblings.length ?? 0) > 0 ? (
        <p className="mt-1 text-2xs text-muted">
          The board asks this once and accepts either half; both are listed because each is
          counted separately above.
        </p>
      ) : null}

      {topic !== null && reason === "policy-unset" ? (
        <p className="mt-1 text-xs text-muted">
          One rule answers this on every board:{" "}
          <Link href="/settings/answers#situation" className="underline">
            {topicLabel(topic)}
          </Link>
          .
        </p>
      ) : null}

      {copy.answerable ? (
        <>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={`gap-input-${field.name}`} className="sr-only">
                Your answer to {field.label}
              </label>
              {options.length > 0 ? (
                <select
                  id={`gap-input-${field.name}`}
                  data-testid={`gap-input-${field.name}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
                >
                  {/* Opens on nothing. A preselected option on a knockout or a
                      demographic question is the one thing this design exists to
                      prevent, and a select whose first entry is an answer has
                      preselected one. */}
                  <option value="">Choose an answer</option>
                  {options.map((o, i) => (
                    <option key={i} value={String(i)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`gap-input-${field.name}`}
                  data-testid={`gap-input-${field.name}`}
                  type="text"
                  value={draft}
                  maxLength={8000}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
                />
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="primary"
              data-testid={`gap-save-${field.name}`}
              // `blankTrim`, not `String.trim()`: the store refuses a
              // zero-width-only answer and `trim()` does not strip U+200B, so an
              // enabled button here buys a round trip and a confusing toast.
              disabled={options.length > 0 ? chosen === undefined : blankTrim(draft) === ""}
              onClick={() =>
                onSave({
                  question: field.label,
                  answer: chosen ? chosen.label : draft,
                  kind,
                  company: canScope && onlyHere ? company : "",
                  declined: chosen?.declineToAnswer === true,
                })
              }
            >
              Save answer
            </Button>
          </div>

          {canScope ? (
            <label
              className="mt-1.5 flex items-start gap-1.5 text-xs text-muted"
              data-testid={`gap-scope-${field.name}`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                data-testid={`gap-scope-input-${field.name}`}
                checked={onlyHere}
                onChange={(e) => setOnlyHere(e.target.checked)}
              />
              {/* Terse on purpose. Nine gap cards each carrying the full
                  explanation is nine copies of one sentence, which is how a
                  screen teaches somebody to stop reading it — the reason the rest
                  of the surface says a thing once, at the top. */}
              <span>
                Only at {company}
                {scoped ? " — usually different from one company to the next, so it starts here" : ""}
              </span>
            </label>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/** One filled field: the value, the layer, and where it came from. */
function FilledRow({ field, source: formField }: { field: StagedField; source?: FormField }) {
  const source = describeSource(field.source);
  const suggested = field.provenance === "suggested";
  /**
   * What a PERSON sees, which is not always what gets submitted.
   *
   * Greenhouse's Yes/No selects are `{label: "Yes", value: 1}` and the engine
   * stages the VALUE, because that is what a board accepts. Rendering it raw put
   * "Will you require visa sponsorship? → 0" on screen — a machine token in front
   * of a human (matrix row 181's family), and one that reads like the wrong
   * answer. The label is shown and the submitted token is named beside it, so
   * neither has to be guessed at.
   */
  const option = formField?.options.find((o) => o.value === field.answer);
  const shown = option?.label ?? field.answer ?? "";
  const submits = option && option.label !== option.value ? option.value : null;
  return (
    <li
      className="py-2"
      data-testid={`field-${field.name}`}
      data-layer={field.layer ?? ""}
      data-declined={field.declined ? "true" : "false"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm">{field.label}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={suggested ? "warn" : "neutral"} data-testid={`field-${field.name}-layer`}>
            {/* A refusal is not an answer, and "Saved answer" over "I don't wish
                to answer" describes somebody's silence as a statement. */}
            {field.declined ? "You chose not to answer" : layerLabel(field.layer)}
          </Badge>
          {suggested ? <Badge tone="warn">Nobody has confirmed this</Badge> : null}
        </div>
      </div>
      <p className="mt-0.5 text-sm font-medium" data-testid={`field-${field.name}-value`}>
        {shown}
      </p>
      <p className="text-2xs text-muted" data-testid={`field-${field.name}-source`}>
        {submits ? `submits as ${submits} · ` : ""}
        {source.what}
        {source.topic ? ` · ${topicLabel(source.topic)}` : ""}
        {source.company ? ` · only at ${source.company}` : ""}
        {/* The DIRECTION, never omitted. "We read this as the opposite of your
            rule" is the half a person needs to catch a misread question. */}
        {source.direction ? ` · ${source.direction}` : ""}
        {field.citation ? ` · ${field.citation}` : ""}
      </p>
    </li>
  );
}
