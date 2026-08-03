import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { DecisionRow } from "@/components/ds/decision-row";

/**
 * The row's own contract, at the level the E2E suite cannot reach.
 *
 * The mismatch chip is here rather than in `triage.spec.ts` because no route
 * can currently produce one: the gate filters a posting whose years exceed the
 * profile's limit before it reaches the queue, so the chip needs the advisory
 * limit E5 brings. The chip is authored UI and it is wired; this is what keeps
 * it from being unproven code in the meantime. See the note in
 * `tests/e2e/triage.spec.ts`.
 */
const FACTS = {
  pay: "$150k–$190k",
  years: "6+ yrs",
  place: "Hybrid, New York",
  age: "2d ago",
};

function row(over: Partial<React.ComponentProps<typeof DecisionRow>> = {}) {
  const noop = vi.fn();
  return render(
    <ul>
      <DecisionRow
        company="Ramp"
        title="Senior Product Manager, Risk"
        facts={FACTS}
        onToggleSelect={noop}
        onInterested={noop}
        onPass={noop}
        onLater={noop}
        {...over}
      />
    </ul>,
  );
}

describe("DecisionRow", () => {
  it("renders the mismatch as a reason sentence, with the word and not only a colour", () => {
    row({ mismatch: "Asks for 6+ years; your profile says 4." });
    // The sentence itself is on screen — a coloured pill carrying no words is
    // what 01 §2 #6 forbids, and it is invisible to a colour-blind reader.
    expect(screen.getByText("Asks for 6+ years; your profile says 4.")).toBeInTheDocument();
    // ...and the raw gate token never is.
    expect(screen.queryByText(/yoe:/)).toBeNull();
  });

  it("renders no chip at all when there is no mismatch", () => {
    row({ mismatch: null });
    expect(screen.queryByText(/your profile says/)).toBeNull();
  });

  it("holds every fact slot, so an unstated value is 'Not listed' and never a gap", () => {
    row({ facts: { ...FACTS, pay: "Not listed", years: "Not listed", age: null } });
    expect(screen.getByTestId("fact-pay")).toHaveTextContent("Not listed");
    expect(screen.getByTestId("fact-years")).toHaveTextContent("Not listed");
    expect(screen.getByTestId("fact-place")).toHaveTextContent("Hybrid, New York");
  });

  it("names the checkbox with the row it selects, so a list of them is not five 'Select's", () => {
    row();
    expect(screen.getByRole("checkbox")).toHaveAccessibleName(
      "Select Ramp, Senior Product Manager, Risk",
    );
  });

  /**
   * The resting row's actions are NOT asserted here.
   *
   * They are hidden by a class, and jsdom loads no stylesheet, so `hidden` and
   * `sr-only` are indistinguishable in this environment — a query here passes
   * under both and would be a test that cannot fail. Measured: swapping
   * `sr-only` back to the seed's `hidden` left all six cases green. The claim
   * lives in `tests/e2e/triage.spec.ts` ("the row's actions are reachable by
   * keyboard, not only by hover"), where the CSS is real.
   */

  it("distinguishes each row's actions by name, so a list is not three unlabelled verbs", () => {
    row();
    expect(
      screen.getByRole("button", { name: "Interested: Ramp, Senior Product Manager, Risk" }),
    ).toBeInTheDocument();
  });
});
