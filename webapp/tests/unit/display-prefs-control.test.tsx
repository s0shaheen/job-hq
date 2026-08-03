import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * THE ASSERTION THE E5 SUITE DID NOT HAVE: what the autosave control does when
 * the write never comes back.
 *
 * `tests/unit/display-prefs.test.ts` proves the parser, `tests/db/` proves the
 * function, and `tests/e2e/profile.spec.ts` proves the happy round trip. All
 * three drove a server that answered. The control shipped with no bound and no
 * catch on `setDisplayPrefsAction`, so on the two paths a phone actually hits:
 *
 *   * offline — a server action REJECTS, the rejection was never caught, and
 *     `pending` stayed set. The control was disabled forever with nothing on
 *     screen saying why, and the ONLY way back was a reload the person had no
 *     reason to attempt. Autosave makes this worse than it is anywhere else in
 *     the app: there is no Save button to press again.
 *   * a slow or hung round trip — same end state, reached without an error at
 *     all. Every other write in this app carries a 15s bound for exactly this
 *     (`profile-form.tsx`, `pipeline-table.tsx`, `use-writes.ts`,
 *     `wizard.tsx`, `review.tsx`); this one was the exception.
 *
 * Both cases assert the same two things, because they are what "the control came
 * back" means: an error a person can read, and a control they can operate. The
 * third case pins the idempotency key across a retry, which is what makes "try
 * again" safe to tell them.
 *
 * RETARGETED, NOT WEAKENED, by RM-34. The control these three cases were written
 * against was `display-prefs.tsx`, two checkboxes on the old single-column
 * `/settings`. `Settings.dc.html` draws all five knobs as selects and a switch
 * behind a section rail, so the component is `preferences-form.tsx` and the
 * gesture is a `change` on a select. The write path underneath is the same
 * action, the bound is the same 15 seconds, and every assertion below is the
 * one it always made.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  setDisplayPrefsAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/actions", () => ({
  setDisplayPrefsAction: mocks.setDisplayPrefsAction,
}));
const { setDisplayPrefsAction } = mocks;

const { PreferencesForm } = await import("@/app/(app)/settings/preferences-form");

const PREFS = {
  density: "dense",
  typeScale: "default",
  keyboardHints: true,
  landingView: "",
  theme: "system",
  updatedAt: "2026-07-28T00:00:00.000Z",
} as const;

function renderControl() {
  return render(<PreferencesForm prefs={{ ...PREFS }} />);
}

/** The gesture: pick Large on the type-size select. */
function chooseLargeType() {
  fireEvent.change(screen.getByTestId("prefs-type-scale"), { target: { value: "large" } });
}

describe("the display preferences control when the write does not come back", () => {
  beforeEach(() => {
    vi.useRealTimers();
    setDisplayPrefsAction.mockReset();
  });

  it("offline: shows an error and re-enables the control rather than hanging", async () => {
    // What a server action does with no network: it rejects. Not `ok: false`.
    setDisplayPrefsAction.mockRejectedValue(new Error("Failed to fetch"));
    renderControl();

    chooseLargeType();

    await waitFor(() => expect(screen.getByTestId("preferences-error")).toBeTruthy());
    expect(screen.getByTestId("preferences-error").textContent).toMatch(/connection/i);
    // The part that was broken: the person can try again. Asserted across the
    // WHOLE control rather than on the one knob that was touched, because
    // `busy` disables all five and a half-fix that re-enabled only the last one
    // used would pass a narrower check.
    for (const id of [
      "prefs-density",
      "prefs-type-scale",
      "prefs-theme",
      "prefs-landing-view",
      "prefs-keyboard-hints",
    ]) {
      expect((screen.getByTestId(id) as HTMLInputElement).disabled).toBe(false);
    }
  });

  it("a hung write is bounded, not left disabled forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Never settles. Without a bound this is the control's permanent state.
    setDisplayPrefsAction.mockReturnValue(new Promise(() => {}));
    renderControl();

    chooseLargeType();
    expect((screen.getByTestId("prefs-type-scale") as HTMLSelectElement).disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);

    await waitFor(() => expect(screen.getByTestId("preferences-error")).toBeTruthy());
    expect(screen.getByTestId("preferences-error").textContent).toMatch(/too long/i);
    expect((screen.getByTestId("prefs-type-scale") as HTMLSelectElement).disabled).toBe(false);
    vi.useRealTimers();
  });

  it("retrying the same gesture reuses the idempotency key, so it cannot write twice", async () => {
    setDisplayPrefsAction.mockRejectedValue(new Error("Failed to fetch"));
    renderControl();

    chooseLargeType();
    await waitFor(() => expect(setDisplayPrefsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("preferences-error")).toBeTruthy());

    chooseLargeType();
    await waitFor(() => expect(setDisplayPrefsAction).toHaveBeenCalledTimes(2));

    const first = setDisplayPrefsAction.mock.calls[0][0] as { idempotencyKey: string };
    const second = setDisplayPrefsAction.mock.calls[1][0] as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    // And it is a real key, not an empty string the server would refuse.
    expect(first.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("one knob per call: turning density never restates the other four", async () => {
    // The reason every value in `SetDisplayPrefsInput` is optional. A control
    // that sent all five would replay whatever it last READ into the other four,
    // so a second device's change would be quietly undone by the next gesture
    // here. Asserted over the whole payload, not by checking one absent key.
    setDisplayPrefsAction.mockResolvedValue({ ok: true, changed: true });
    renderControl();

    fireEvent.change(screen.getByTestId("prefs-landing-view"), { target: { value: "jobs" } });
    await waitFor(() => expect(setDisplayPrefsAction).toHaveBeenCalledTimes(1));

    const payload = setDisplayPrefsAction.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["expectedUpdatedAt", "idempotencyKey", "landingView"].sort(),
    );
    expect(payload.landingView).toBe("jobs");
  });
});
