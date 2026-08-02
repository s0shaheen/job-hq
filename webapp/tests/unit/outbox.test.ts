import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import type { TriageInput, WriteResult } from "@/lib/data/source";
import type { JobView } from "@/lib/data/view-models";
import type { PendingGesture } from "@/lib/outbox";

/**
 * The invariant under test: no decision disappears without the user being
 * told. The banner promises "saved on this device and will sync
 * automatically", and every case here is a way that promise was once broken
 * in silence — a rejection or conflict that vanished with the banner, a
 * poison entry that starved everything queued behind it, a full localStorage
 * that turned "saved" into a lie, an eviction nobody heard about, and an
 * Undo that raced the reconnect flush.
 */

const { setTriageActionMock } = vi.hoisted(() => ({
  setTriageActionMock: vi.fn<(input: TriageInput) => Promise<WriteResult>>(),
}));

vi.mock("@/app/(app)/queue/actions", () => ({
  setTriageAction: (input: TriageInput) => setTriageActionMock(input),
}));

/**
 * sonner is mocked so the Undo handler can be invoked directly. Rendering the
 * real Toaster in jsdom would test sonner's animations, and the thing under
 * test is what the button does — including which of the four outcomes it
 * reports, which is easier to assert on the call than on a rendered toast.
 */
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

/** Presses Undo on the most recent toast that offered it. */
function clickUndo(): void {
  const calls = toastMock.mock.calls as unknown as [string, ToastArgs][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const action = calls[i]?.[1]?.action;
    if (action?.label === "Undo") {
      action.onClick();
      return;
    }
  }
  // Louder than returning a no-op: a test that silently pressed nothing would
  // pass whatever the handler does.
  throw new Error("no Undo toast was raised");
}

const JOB = FIXTURE_JOBS[0] as JobView;
const KEY = "hq.outbox.v1";

type Outbox = typeof import("@/lib/outbox");

// Fresh module per test: the outbox holds module-level state (the in-memory
// quota fallback, the delivered registry) that must not leak across tests.
async function loadOutbox(): Promise<Outbox> {
  return import("@/lib/outbox");
}

async function loadPendingWork() {
  const mod = await import("@/components/pending-work");
  return mod.PendingWork;
}

function gesture(id: string, over: Partial<PendingGesture> = {}): PendingGesture {
  return {
    id,
    input: {
      postingKey: JOB.key,
      triage: "dismissed",
      snoozeUntil: null,
      idempotencyKey: id,
      expectedUpdatedAt: null,
    },
    label: `Passed on ${id}`,
    queuedAt: 1,
    reason: "offline",
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  setTriageActionMock.mockReset();
  setTriageActionMock.mockResolvedValue({ ok: true, job: JOB });
  toastMock.mockReset();
  toastMock.error.mockReset();
  toastMock.warning.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("outbox storage", () => {
  it("quarantines a malformed entry instead of letting it block valid ones", async () => {
    const o = await loadOutbox();
    const valid = gesture("valid-1");
    // A poison entry with no `input` — indistinguishable from what an
    // extension or an older build could have left behind.
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "poison", label: "A poisoned entry", queuedAt: 1, reason: "offline" }, valid]),
    );

    expect(o.listPending()).toEqual([valid]);
    const failed = o.listFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: "poison", label: "A poisoned entry", kind: "corrupt" });
    // and storage self-healed, so the poison cannot come back on the next read
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual([valid]);
  });

  it("holds a decision in memory when localStorage is full, and reports degraded durability", async () => {
    const o = await loadOutbox();
    const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    const g = gesture("q-1");
    // false = not durable. The old code swallowed the throw and returned as if
    // saved; read() re-read localStorage, so the decision existed nowhere.
    expect(o.enqueue(g)).toBe(false);
    expect(o.listPending()).toEqual([g]);
    expect(o.storageDegraded()).toBe(true);

    quota.mockRestore();
    const g2 = gesture("q-2");
    expect(o.enqueue(g2)).toBe(true);
    expect(o.storageDegraded()).toBe(false);
    // both survived into durable storage once it started accepting writes again
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual([g, g2]);
  });

  it("evicts past the bound with a visible notice, never silently", async () => {
    const o = await loadOutbox();
    for (let i = 0; i <= 200; i++) o.enqueue(gesture(`g-${i}`));

    const pending = o.listPending();
    expect(pending).toHaveLength(200);
    expect(pending[0]?.id).toBe("g-1");
    const failed = o.listFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: "g-0", label: "Passed on g-0", kind: "evicted" });
  });

  it("dequeue reports whether the gesture was still pending", async () => {
    const o = await loadOutbox();
    o.enqueue(gesture("d-1"));
    expect(o.dequeue("d-1")).toBe(true);
    // Already gone — an Undo handler seeing false must not pretend it undid
    // anything, because the server may already hold the decision.
    expect(o.dequeue("d-1")).toBe(false);
  });

  it("markFailed moves a pending gesture into a dismissible notice", async () => {
    const o = await loadOutbox();
    const g = gesture("f-1");
    o.enqueue(g);
    o.markFailed(g, "rejected", "The server refused it: no such posting.");

    expect(o.listPending()).toEqual([]);
    expect(o.listFailed()).toMatchObject([{ id: "f-1", kind: "rejected" }]);
    o.clearFailed();
    expect(o.listFailed()).toEqual([]);
  });

  it("holds a delivered result for a post-delivery undo, one take each", async () => {
    const o = await loadOutbox();
    o.recordDelivered("u-1", JOB);
    expect(o.takeDelivered("u-1")).toEqual(JOB);
    expect(o.takeDelivered("u-1")).toBeNull();
  });
});

describe("PendingWork flush", () => {
  it("surfaces a server rejection instead of silently discarding the decision", async () => {
    const o = await loadOutbox();
    o.enqueue(gesture("rej-1", { label: "Passed on Ramp — Product Manager, Core Platform" }));
    setTriageActionMock.mockResolvedValue({ ok: false, kind: "error", message: "no such posting" });

    const PendingWork = await loadPendingWork();
    render(React.createElement(PendingWork));

    // The old code dequeued and moved on: the banner disappeared, which reads
    // as "delivered", and the decision was gone with no trace anywhere.
    const strip = await screen.findByTestId("failed-work", undefined, { timeout: 3000 });
    expect(strip.textContent).toContain("Passed on Ramp — Product Manager, Core Platform");
    expect(strip.textContent).toMatch(/no such posting/i);
    await waitFor(() => expect(o.listPending()).toEqual([]));
    expect(o.listFailed()).toMatchObject([{ id: "rej-1", kind: "rejected" }]);
  });

  it("tells the user when a held decision lost to a newer one", async () => {
    const o = await loadOutbox();
    o.enqueue(gesture("con-1", { label: "Saved Plaid — Product Manager, Payments" }));
    setTriageActionMock.mockResolvedValue({ ok: false, kind: "conflict", current: JOB });

    const PendingWork = await loadPendingWork();
    render(React.createElement(PendingWork));

    const strip = await screen.findByTestId("failed-work", undefined, { timeout: 3000 });
    expect(strip.textContent).toContain("Saved Plaid — Product Manager, Payments");
    expect(strip.textContent).toMatch(/another device/i);
    await waitFor(() => expect(o.listPending()).toEqual([]));
    expect(o.listFailed()).toMatchObject([{ id: "con-1", kind: "conflict" }]);
  });

  it("delivers valid decisions past a malformed entry instead of starving them", async () => {
    const valid = gesture("ok-1");
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "poison", label: "A poisoned entry", queuedAt: 1, reason: "offline" }, valid]),
    );
    // Faithful to the real action: malformed input never resolves cleanly.
    // A mock that shrugged at `undefined` would hide the starvation this test
    // exists to catch.
    setTriageActionMock.mockImplementation(async (input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("malformed input reached the server action");
      }
      return { ok: true, job: JOB };
    });

    const PendingWork = await loadPendingWork();
    render(React.createElement(PendingWork));

    // The old loop threw on the poison entry every pass, remarked the queue
    // "offline", and the valid decision behind it was never sent.
    await waitFor(() => expect(setTriageActionMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(setTriageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "ok-1" }),
    );
    const o = await loadOutbox();
    await waitFor(() => expect(o.listPending()).toEqual([]));
    expect(o.listFailed()).toMatchObject([{ id: "poison", kind: "corrupt" }]);
  });

  it("holds a freshly queued gesture for the undo window, then delivers it", async () => {
    vi.useFakeTimers();
    const o = await loadOutbox();
    const PendingWork = await loadPendingWork();
    render(React.createElement(PendingWork));

    act(() => {
      o.enqueue(gesture("undo-1"));
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // The old code flushed here, inside the 8s Undo window: the Undo click
    // then dequeued nothing while the server kept the decision.
    expect(setTriageActionMock).not.toHaveBeenCalled();
    // Undo inside the window is a genuine local removal.
    expect(o.dequeue("undo-1")).toBe(true);

    // Re-queue and let the window pass: delivery must still happen on its own.
    act(() => {
      o.enqueue(gesture("undo-2"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(setTriageActionMock).toHaveBeenCalledTimes(1);
    expect(setTriageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "undo-2" }),
    );
    expect(o.listPending()).toEqual([]);
  });
});

/**
 * The hold above narrows the race; it does not remove it. The flush can deliver
 * a gesture while its Undo toast is still on screen — the toast's own timer
 * pauses under the pointer, and a second tab has its own hold. Undo then cannot
 * be a local removal, and `dequeue` returning false is the only signal that it
 * is not. Discarding that answer restored the card while the server kept the
 * decision: the screen and the database disagreeing, with nothing admitting it.
 */
describe("Undo after a background delivery", () => {
  /** The updated_at the delivery returned — a compensating write needs THIS. */
  const DELIVERED: JobView = { ...JOB, updatedAt: "2026-07-21T16:00:00.000Z" };

  async function passFirstCardOffline() {
    const o = await loadOutbox();
    const mod = await import("@/app/(app)/queue/triage-queue");
    // The gesture never reaches the server, so `decide` defers it: outbox
    // entry plus the Undo toast this suite is about.
    setTriageActionMock.mockRejectedValueOnce(new Error("network down"));
    render(React.createElement(mod.default, { initial: [JOB] }));

    fireEvent.click(screen.getByTestId("pass"));
    await waitFor(() => expect(o.listPending()).toHaveLength(1));
    return { o, id: o.listPending()[0]!.id };
  }

  it("sends a compensating write when the gesture already left the queue", async () => {
    const { o, id } = await passFirstCardOffline();

    // Exactly what PendingWork's flush does on a successful delivery.
    act(() => {
      o.recordDelivered(id, DELIVERED);
      o.dequeue(id);
    });

    setTriageActionMock.mockResolvedValue({ ok: true, job: { ...DELIVERED, triage: "" } });
    await act(async () => {
      clickUndo();
    });

    // The undo the server has to be told about, against the delivered version.
    // Without this the card returned to the screen and the pass stood.
    await waitFor(() =>
      expect(setTriageActionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          postingKey: JOB.key,
          triage: "",
          expectedUpdatedAt: DELIVERED.updatedAt,
        }),
      ),
    );
    // One take each: the delivered result is consumed, not left for a second
    // click to replay against a version the server has already moved past.
    expect(o.takeDelivered(id)).toBeNull();
  });

  it("reuses the conflict wording when the compensating write loses", async () => {
    const { o, id } = await passFirstCardOffline();
    act(() => {
      o.recordDelivered(id, DELIVERED);
      o.dequeue(id);
    });

    setTriageActionMock.mockResolvedValue({ ok: false, kind: "conflict", current: JOB });
    await act(async () => {
      clickUndo();
    });

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        "Couldn't undo. This was changed somewhere else.",
      ),
    );
  });

  it("says it could not undo when there is no delivered result to compensate", async () => {
    const { o, id } = await passFirstCardOffline();

    // The gesture left the queue WITHOUT being delivered — the flush rejected
    // or conflicted it. There is no delivered updated_at, so a compensating
    // write would conflict on its own; the honest move is saying so.
    act(() => {
      o.dequeue(id);
    });

    const before = setTriageActionMock.mock.calls.length;
    await act(async () => {
      clickUndo();
    });

    expect(setTriageActionMock.mock.calls.length).toBe(before);
    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't undo that.",
      expect.objectContaining({
        description: expect.stringMatching(/already left this device/i),
      }),
    );
    // The card must NOT come back: it is on screen as undone, or it is honest.
    expect(screen.queryByText(JOB.title)).toBeNull();
  });

  it("stays a plain local removal while the gesture is still pending", async () => {
    const { o } = await passFirstCardOffline();

    const before = setTriageActionMock.mock.calls.length;
    await act(async () => {
      clickUndo();
    });

    // Nothing was ever sent, so nothing needs compensating — and the card comes
    // back, which is the whole point of an undo inside the hold.
    expect(setTriageActionMock.mock.calls.length).toBe(before);
    expect(o.listPending()).toEqual([]);
    await waitFor(() => expect(screen.getByText(JOB.title)).toBeTruthy());
  });
});
