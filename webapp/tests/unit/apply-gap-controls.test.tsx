import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * THE ASSERTION NOTHING HAD: a gap control cannot save until somebody chooses.
 *
 * `webapp/lib/apply/index.ts` prohibition 1 is "never fill a gap on the user's
 * behalf… do not preselect an option", and every test of it looked at the SELECT
 * (`value === ""`, zero `selected` attributes) — which was always correct. Nothing
 * looked at the Save button beside it.
 *
 * So when the option value moved from the label to the index, `Number("")` being
 * 0 made `chosen` equal `options[0]` before any interaction: Save was live on a
 * freshly rendered card and one click wrote the board's FIRST option into the
 * library. A knockout "Yes", an EEO answer, or — on a board listing its decline
 * first — a refusal, none of them chosen by anybody, and each replayed by the
 * growth loop on every board wording the question the same way.
 *
 * Five gates were green through all of it. The hole was the shape of the
 * assertions, not their number, so this file asserts the DISABLED STATE across
 * every control the two surfaces put in front of a gap: a select, a text box, and
 * (on the settings side) a radio group.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// `vi.hoisted`, because a `vi.mock` factory is hoisted above every declaration:
// referencing a plain `const` from inside one is a TDZ error, and wrapping it in a
// lambda to dodge that erases the argument types the assertions read back.
const mocks = vi.hoisted(() => ({
  saveAnswerAction: vi.fn(async (_input: unknown) => ({
    ok: false,
    kind: "error",
    message: "stub",
  })),
}));
vi.mock("@/lib/apply/actions", () => ({
  saveAnswerAction: mocks.saveAnswerAction,
  deleteAnswerAction: vi.fn(),
  saveRuleAction: vi.fn(),
  deleteRuleAction: vi.fn(),
}));
const { saveAnswerAction } = mocks;

const { ReviewSurface } = await import("@/app/(app)/apply/[applicationId]/review");
const { FactControl } = await import("@/app/(app)/settings/answers/fact-controls");
const { parseGreenhouseForm } = await import("@/lib/apply/greenhouse");
const { prepareApplication } = await import("@/lib/apply/prepare");

/** Greenhouse's own payload shape, with every gap kind a control is rendered for. */
function board() {
  return parseGreenhouseForm({
    id: 4410982,
    title: "Product Manager, Billing",
    company_name: "Stripe",
    absolute_url: "https://boards.greenhouse.io/stripe/jobs/4410982",
    questions: [
      // A knockout SELECT with no rule: `policy-unset`, the state the whole
      // design exists to produce, and the one a stray click is worst on.
      {
        label: "Are you at least 18 years of age?",
        required: true,
        fields: [
          {
            name: "age",
            type: "multi_value_single_select",
            values: [
              { label: "Yes", value: "1" },
              { label: "No", value: "0" },
            ],
          },
        ],
      },
      // Two options sharing a LABEL — board content is third-party, and this is
      // why the value is the index rather than the label.
      {
        label: "Do you have a US work permit?",
        required: false,
        fields: [
          {
            name: "dupe",
            type: "multi_value_single_select",
            values: [
              { label: "Yes", value: "7" },
              { label: "Yes", value: "8" },
            ],
          },
        ],
      },
      // A free-text gap: no options, so the other branch of the control.
      {
        label: "What is your GitHub profile?",
        required: false,
        fields: [{ name: "github", type: "input_text" }],
      },
    ],
    location_questions: [],
    demographic_questions: {
      questions: [
        {
          id: 5001,
          label: "Gender",
          required: false,
          type: "multi_value_single_select",
          answer_options: [
            { id: 1, label: "Man" },
            { id: 2, label: "Woman" },
            { id: 3, label: "I don't wish to answer", decline_to_answer: true },
          ],
        },
        {
          // A board that lists its DECLINE option FIRST. Nothing says Greenhouse
          // orders them, and it is the worst version of the bug: the stray click
          // records a refusal rather than an answer.
          id: 5002,
          label: "Race",
          required: false,
          type: "multi_value_single_select",
          answer_options: [
            { id: 9, label: "I don't wish to answer", decline_to_answer: true },
            { id: 1, label: "Asian" },
          ],
        },
      ],
    },
    compliance: null,
    data_compliance: [],
  });
}

function renderReview(company = "Stripe") {
  const staged = prepareApplication({
    form: board(),
    answers: [],
    rules: [],
    companyKey: "stripe",
    today: new Date("2026-07-27T00:00:00.000Z"),
  });
  render(
    <ReviewSurface
      staged={staged}
      company={company}
      title="Product Manager, Billing"
      boardUrl="https://boards.greenhouse.io/stripe/jobs/4410982"
    />,
  );
  return staged;
}

beforeEach(() => {
  saveAnswerAction.mockClear();
});

/**
 * The surface queues each write behind the last one (`tail.current.then(run, run)`),
 * so the action lands in a MICROTASK rather than in the click handler. Every
 * assertion about it therefore waits, and every assertion that it did NOT happen
 * flushes first — otherwise "not called" is true of any click, including one that
 * is about to write.
 */
async function saved(n = 1) {
  await waitFor(() => expect(saveAnswerAction).toHaveBeenCalledTimes(n));
  return saveAnswerAction.mock.calls[n - 1][0];
}

async function nothingQueued() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(saveAnswerAction).not.toHaveBeenCalled();
}

describe("a gap control cannot save until somebody chooses", () => {
  it("REGRESSION: EVERY gap Save is disabled on a freshly rendered surface", async () => {
    // The sweep, and the assertion whose absence let `Number("") === 0` past five
    // green gates. It covers controls this file does not name individually, and it
    // covers the ones a later board shape adds.
    const staged = renderReview();
    const saves = document.querySelectorAll<HTMLButtonElement>('[data-testid^="gap-save-"]');
    expect(saves.length).toBeGreaterThanOrEqual(5);
    const live = [...saves].filter((b) => !b.disabled).map((b) => b.getAttribute("data-testid"));
    expect(live).toEqual([]);
    // …and the select half, which was always right, so a fix that broke IT would
    // not hide behind the button assertion.
    for (const sel of document.querySelectorAll<HTMLSelectElement>('select[data-testid^="gap-input-"]')) {
      expect(sel.value).toBe("");
      expect(sel.querySelectorAll("option[selected]")).toHaveLength(0);
    }
    // Nothing was written by rendering, either.
    await nothingQueued();
    expect(staged.readiness).toBe("blocked");
  });

  it("a knockout SELECT: disabled at nothing, and it saves what was CHOSEN", async () => {
    renderReview();
    const save = screen.getByTestId("gap-save-age") as HTMLButtonElement;
    expect(save).toBeDisabled();
    // The click a person makes by reflex on a card that looks ready.
    fireEvent.click(save);
    await nothingQueued();

    // Index 1 is "No" — the SECOND option, so a fix that reads index 0 whatever
    // is chosen fails here rather than passing on a coincidence.
    fireEvent.change(screen.getByTestId("gap-input-age"), { target: { value: "1" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(await saved()).toMatchObject({
      question: "Are you at least 18 years of age?",
      answer: "No",
      declined: false,
    });
  });

  it("a board that lists its DECLINE first records nothing on a stray click", async () => {
    renderReview();
    const save = screen.getByTestId("gap-save-demographic_5002") as HTMLButtonElement;
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await nothingQueued();

    // And when it IS chosen, it is recorded as the refusal it is — the M2 half,
    // asserted from the ordering that made the preselect worst.
    fireEvent.change(screen.getByTestId("gap-input-demographic_5002"), { target: { value: "0" } });
    fireEvent.click(save);
    expect(await saved()).toMatchObject({
      question: "Race",
      answer: "I don't wish to answer",
      kind: "eeo",
      declined: true,
    });
  });

  it("a demographic SELECT does not stage an identity nobody gave", async () => {
    renderReview();
    const save = screen.getByTestId("gap-save-demographic_5001") as HTMLButtonElement;
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await nothingQueued();
    // Index 1 is "Woman"; index 0 is "Man". The distinction is the whole test.
    fireEvent.change(screen.getByTestId("gap-input-demographic_5001"), { target: { value: "1" } });
    fireEvent.click(save);
    expect(await saved()).toMatchObject({ answer: "Woman", declined: false });
  });

  it("two options sharing a label stay distinguishable", async () => {
    // The reason the value is the index at all (m9). Choosing the SECOND "Yes"
    // has to be a different gesture from choosing the first, and neither may be
    // reachable without a choice.
    renderReview();
    const save = screen.getByTestId("gap-save-dupe") as HTMLButtonElement;
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("gap-input-dupe"), { target: { value: "1" } });
    fireEvent.click(save);
    expect(await saved()).toMatchObject({ answer: "Yes" });
    const options = screen.getByTestId("gap-input-dupe").querySelectorAll("option");
    expect([...options].map((o) => (o as HTMLOptionElement).value)).toEqual(["", "0", "1"]);
  });

  it("a TEXT gap is disabled at empty and at whitespace the store refuses", async () => {
    renderReview();
    const save = screen.getByTestId("gap-save-github") as HTMLButtonElement;
    const input = screen.getByTestId("gap-input-github");
    expect(save).toBeDisabled();
    // A zero-width space is blank to `hq_blank_trim` and not to `String.trim()`,
    // so an enabled button here buys a refused round trip (n4).
    fireEvent.change(input, { target: { value: "​ ​" } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "https://github.com/example" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(await saved()).toMatchObject({
      answer: "https://github.com/example",
      declined: false,
    });
  });

  it("the scope checkbox decides where it lands and never what it is", async () => {
    renderReview();
    fireEvent.change(screen.getByTestId("gap-input-age"), { target: { value: "0" } });
    // Off by default on a person-fact topic; ticking it scopes the save.
    const scope = screen.getByTestId("gap-scope-input-age") as HTMLInputElement;
    expect(scope.checked).toBe(false);
    fireEvent.click(scope);
    fireEvent.click(screen.getByTestId("gap-save-age"));
    expect(await saved()).toMatchObject({ company: "Stripe", answer: "Yes" });
  });
});

describe("a RADIO situation control opens on nothing", () => {
  it("has no checked radio and no way to commit an unset one", () => {
    // The third control shape, on the settings side. Boolean topics commit on
    // click rather than through a Save, so the invariant is the checked state
    // itself: a preselected radio on "do you need visa sponsorship?" is the same
    // failure as a preselected option, one surface over.
    const onChange = vi.fn();
    render(
      <FactControl idPrefix="topic-visa_sponsorship" field="boolean" draft={null} disabled={false} onChange={onChange} />,
    );
    const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBeGreaterThan(0);
    expect([...radios].filter((r) => r.checked)).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
