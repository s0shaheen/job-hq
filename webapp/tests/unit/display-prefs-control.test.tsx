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
 *     `pending` stayed set. The checkbox was disabled forever with nothing on
 *     screen saying why, and the ONLY way back was a reload the person had no
 *     reason to attempt. Autosave makes this worse than it is anywhere else in
 *     the app: there is no Save button to press again.
 *   * a slow or hung round trip — same end state, reached without an error at
 *     all. Every other write in this app carries a 15s bound for exactly this
 *     (`profile-form.tsx`, `pipeline-table.tsx`, `use-writes.ts`,
 *     `wizard.tsx`, `review.tsx`); this one was the exception.
 *
 * Both cases assert the same two things, because they are what "the control
 * came back" means: an error a person can read, and a checkbox they can click.
 * The third case pins the idempotency key across a retry, which is what makes
 * "try again" safe to tell them.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  setDisplayPrefsAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/actions", () => ({
  setDisplayPrefsAction: mocks.setDisplayPrefsAction,
}));
const { setDisplayPrefsAction } = mocks;

const { DisplayPrefs } = await import("@/app/(app)/settings/display-prefs");

const PREFS = {
  density: "dense",
  typeScale: "default",
  keyboardHints: true,
  landingView: "",
  theme: "system",
  updatedAt: "2026-07-28T00:00:00.000Z",
} as const;

function renderControl() {
  return render(<DisplayPrefs prefs={{ ...PREFS }} />);
}

describe("the display preferences control when the write does not come back", () => {
  beforeEach(() => {
    vi.useRealTimers();
    setDisplayPrefsAction.mockReset();
  });

  it("offline: shows an error and re-enables the checkbox rather than hanging", async () => {
    // What a server action does with no network: it rejects. Not `ok: false`.
    setDisplayPrefsAction.mockRejectedValue(new Error("Failed to fetch"));
    renderControl();

    const box = screen.getByTestId("display-large") as HTMLInputElement;
    fireEvent.click(box);

    await waitFor(() => expect(screen.getByTestId("display-error")).toBeTruthy());
    expect(screen.getByTestId("display-error").textContent).toMatch(/connection/i);
    // The part that was broken: the person can try again.
    expect((screen.getByTestId("display-large") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("display-comfortable") as HTMLInputElement).disabled).toBe(false);
  });

  it("a hung write is bounded, not left disabled forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Never settles. Without a bound this is the checkbox's permanent state.
    setDisplayPrefsAction.mockReturnValue(new Promise(() => {}));
    renderControl();

    fireEvent.click(screen.getByTestId("display-large"));
    expect((screen.getByTestId("display-large") as HTMLInputElement).disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);

    await waitFor(() => expect(screen.getByTestId("display-error")).toBeTruthy());
    expect(screen.getByTestId("display-error").textContent).toMatch(/too long/i);
    expect((screen.getByTestId("display-large") as HTMLInputElement).disabled).toBe(false);
    vi.useRealTimers();
  });

  it("retrying the same gesture reuses the idempotency key, so it cannot write twice", async () => {
    setDisplayPrefsAction.mockRejectedValue(new Error("Failed to fetch"));
    renderControl();

    fireEvent.click(screen.getByTestId("display-large"));
    await waitFor(() => expect(setDisplayPrefsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("display-error")).toBeTruthy());

    fireEvent.click(screen.getByTestId("display-large"));
    await waitFor(() => expect(setDisplayPrefsAction).toHaveBeenCalledTimes(2));

    const first = setDisplayPrefsAction.mock.calls[0][0] as { idempotencyKey: string };
    const second = setDisplayPrefsAction.mock.calls[1][0] as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    // And it is a real key, not an empty string the server would refuse.
    expect(first.idempotencyKey.length).toBeGreaterThan(0);
  });
});
