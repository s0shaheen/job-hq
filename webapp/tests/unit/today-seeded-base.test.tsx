import { act, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import type { JobView } from "@/lib/data/view-models";

/**
 * Undo has to survive the server re-rendering the route underneath it.
 *
 * A server action re-renders the route it was called from, so the moment a
 * decision lands, Today's `initial` prop comes back WITHOUT that posting —
 * `src.queue()` returns undecided rows by definition. `useDecisions` overlays
 * its patches onto whatever base it is handed, so if the base follows the
 * server, the row an undo restores is no longer in it and cannot be shown. The
 * compensating write reaches the database and the screen never admits it: the
 * exact "screen says one thing, database says another" failure this estate
 * exists to prevent.
 *
 * This is a UNIT test on purpose. The bug was first caught in a browser (by
 * the retired undo-delivery.spec.ts), but only when the server's re-render
 * happened to land before the Undo click — re-broken deliberately, that spec
 * passed. A test that catches a defect only sometimes is not the guard this
 * needs, so the ordering is forced here instead of raced.
 *
 * MUTATION: change `const [base] = React.useState(initial)` to
 * `const base = initial` in `today-list.tsx` and the final assertion fails —
 * the row never comes back.
 */

const { setTriageBulkActionMock } = vi.hoisted(() => ({
  setTriageBulkActionMock: vi.fn(),
}));

vi.mock("@/app/(app)/jobs/bulk-actions", () => ({
  setTriageBulkAction: (i: unknown) => setTriageBulkActionMock(i),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

type ToastArgs = { action?: { label: string; onClick: () => void } };
const { toastMock } = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  });
  return { toastMock: fn };
});
vi.mock("sonner", () => ({ toast: toastMock }));

function clickUndo(): void {
  const calls = toastMock.mock.calls as unknown as [string, ToastArgs][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const action = calls[i]?.[1]?.action;
    if (action?.label === "Undo") {
      action.onClick();
      return;
    }
  }
  throw new Error("no Undo toast was raised");
}

const [A, B] = FIXTURE_JOBS as JobView[];
const TODAY = "2026-07-21";

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  toastMock.mockReset();
  toastMock.error.mockReset();
  toastMock.warning.mockReset();
  setTriageBulkActionMock.mockReset();
});

describe("Today's base list", () => {
  // Generous timeouts, not because the work is slow but because this box runs
  // several containers at once and a guard that dies under load is not a guard.
  it("restores an undone row even after the server re-render dropped it", { timeout: 20_000 }, async () => {
    const mod = await import("@/app/(app)/queue/today-list");
    const List = mod.default;

    // The write succeeds and comes back decided, which is what removes the row.
    const written: JobView = { ...A, triage: "dismissed", updatedAt: "2026-07-21T16:00:00.000Z" };
    const restored: JobView = { ...written, triage: "", updatedAt: "2026-07-21T16:00:01.000Z" };
    // Both calls are BULK: a delivered batch is undone by the inverse batch, so
    // the undo comes back through the same action rather than the single-row one.
    setTriageBulkActionMock
      .mockResolvedValueOnce({ ok: true, jobs: [written] })
      .mockResolvedValueOnce({ ok: true, jobs: [restored] });

    const { rerender } = render(<List initial={[A, B]} today={TODAY} />);
    expect(screen.getByText(A.title)).toBeInTheDocument();

    // Decide the first row through its own button.
    await act(async () => {
      screen.getByRole("button", { name: `Pass: ${A.company}, ${A.title}` }).click();
    });
    await waitFor(() => expect(screen.queryByText(A.title)).toBeNull(), { timeout: 10_000 });

    /**
     * THE SERVER RE-RENDER. This is the step the browser test only sometimes
     * reached: the action's own response re-renders the route, and the queue
     * read no longer returns the row that was just decided.
     */
    rerender(<List initial={[B]} today={TODAY} />);
    expect(screen.queryByText(A.title)).toBeNull();

    // Now undo. The compensating write goes out either way; the question is
    // whether the screen can show the row it just restored.
    await act(async () => {
      clickUndo();
    });

    await waitFor(() => expect(setTriageBulkActionMock).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    await waitFor(() =>
      expect(
        screen.queryByText(A.title),
        "undo wrote to the server but the row never came back on screen",
      ).toBeInTheDocument(),
      { timeout: 10_000 },
    );
  });
});
