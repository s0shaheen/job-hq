import { describe, expect, it, vi } from "vitest";
import { dispatchLifecycleEmail } from "@/lib/email/dispatch";
import { FixtureEmailProvider, FixtureEmailStore } from "@/lib/email/fixture";
import type { PendingLifecycleSend } from "@/lib/email/store";

/**
 * The dispatch loop (#203) against the fixture twins — the same loop the real
 * route runs, with zero network by construction. The issue's attack list, one
 * test each: double-send via replay, the crash window, the suppressed address,
 * the loud flag-off skip, and the provider refusing without a success row.
 */

let seq = 0;
function pending(overrides: Partial<PendingLifecycleSend> = {}): PendingLifecycleSend {
  seq += 1;
  return {
    sendKey: `evt:${seq}`,
    userId: `00000000-0000-4000-8000-00000000000${seq % 10}`,
    eventKind: "entitlement.activated",
    email: `person${seq}@example.com`,
    name: "Avery Example",
    occurredAt: "2026-08-13T00:00:00Z",
    ...overrides,
  };
}

describe("dispatchLifecycleEmail", () => {
  it("sends one activation email per event and records the provider message id", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    const item = pending();
    store.seedPending([item]);

    const summary = await dispatchLifecycleEmail({ store, provider, log: () => {} });

    expect(summary).toMatchObject({ considered: 1, sent: 1, failed: 0, skipped: 0 });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toBe(item.email);
    expect(provider.sent[0].subject).toContain("active");
    const row = store.row(item.sendKey);
    expect(row).toMatchObject({
      status: "sent",
      provider: "fixture",
      providerMessageId: "fixture-1",
      kind: "lifecycle.activation",
    });
  });

  it("a second run over the same event sends nothing: the ledger silences it", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    const item = pending();
    store.seedPending([item]);

    await dispatchLifecycleEmail({ store, provider, log: () => {} });
    const again = await dispatchLifecycleEmail({ store, provider, log: () => {} });

    expect(again).toMatchObject({ considered: 0, sent: 0 });
    expect(provider.sent).toHaveLength(1);
    expect(store.ledger).toHaveLength(1);
  });

  it("a row stuck at claimed (the crash window) is never re-sent", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    const item = pending();
    store.seedPending([item]);
    // A previous dispatcher claimed, the provider accepted, the process died
    // before recording. The claim survives; the pending read hides the event.
    await store.claimSend({
      sendKey: item.sendKey,
      userId: item.userId,
      kind: "lifecycle.activation",
      recipient: item.email,
    });

    const summary = await dispatchLifecycleEmail({ store, provider, log: () => {} });

    expect(summary.sent).toBe(0);
    expect(provider.sent).toHaveLength(0);
    expect(store.row(item.sendKey)?.status).toBe("claimed"); // ambiguous stays ambiguous
  });

  it("a suppressed address is refused with the suppression named, and no send happens", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    const item = pending();
    store.suppress(item.email, "bounce", "resend");
    store.seedPending([item]);
    const log = vi.fn();

    const summary = await dispatchLifecycleEmail({ store, provider, log });

    expect(summary).toMatchObject({ suppressed: 1, sent: 0 });
    expect(provider.sent).toHaveLength(0);
    const row = store.row(item.sendKey);
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toContain("bounce");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bounce"));
  });

  it("flag off: no provider touched, a NAMED skipped row lands, and the skip is logged", async () => {
    const store = new FixtureEmailStore();
    const item = pending();
    store.seedPending([item]);
    const log = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const summary = await dispatchLifecycleEmail({
      store,
      provider: null,
      disabledReason: "email disabled: RESEND_API_KEY and EMAIL_SENDER not set",
      log,
    });

    expect(summary).toMatchObject({ skipped: 1, sent: 0 });
    const row = store.row(item.sendKey);
    expect(row?.status).toBe("skipped");
    expect(row?.reason).toContain("RESEND_API_KEY");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SKIPPED"));
    expect(fetchSpy).not.toHaveBeenCalled(); // zero network while disabled
    fetchSpy.mockRestore();
  });

  it("refuses to skip namelessly: null provider without a reason throws", async () => {
    const store = new FixtureEmailStore();
    await expect(
      dispatchLifecycleEmail({ store, provider: null, log: () => {} }),
    ).rejects.toThrow(/silent drop/);
  });

  it("a provider refusal lands as failed with the provider's reason, never a success", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    provider.refuseWith = {
      ok: false,
      outcome: "failed",
      reason: "resend 403: sending domain not verified",
    };
    const item = pending();
    store.seedPending([item]);

    const summary = await dispatchLifecycleEmail({ store, provider, log: () => {} });

    expect(summary).toMatchObject({ failed: 1, sent: 0 });
    const row = store.row(item.sendKey);
    expect(row?.status).toBe("failed");
    expect(row?.reason).toContain("domain not verified");
    expect(row?.providerMessageId).toBe("");
  });

  it("a provider that dies unanswered is recorded unknown, and stays terminal", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    provider.send = async () => {
      throw new Error("socket hang up");
    };
    const item = pending();
    store.seedPending([item]);

    const summary = await dispatchLifecycleEmail({ store, provider, log: () => {} });

    expect(summary.unknown).toBe(1);
    expect(store.row(item.sendKey)?.status).toBe("unknown");
    expect(store.row(item.sendKey)?.reason).toContain("socket hang up");

    // And the next run does not touch it: unknown is never blindly retried.
    const again = await dispatchLifecycleEmail({ store, provider, log: () => {} });
    expect(again.considered).toBe(0);
  });

  it("suspension events render the suspension template", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    store.seedPending([pending({ eventKind: "entitlement.suspended" })]);

    await dispatchLifecycleEmail({ store, provider, log: () => {} });

    expect(provider.sent[0].subject).toContain("suspended");
    expect(store.ledger[0].kind).toBe("lifecycle.suspension");
  });

  it("an event kind outside the map fails loud instead of guessing a template", async () => {
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    store.seedPending([pending({ eventKind: "entitlement.upgraded" })]);

    await expect(dispatchLifecycleEmail({ store, provider, log: () => {} })).rejects.toThrow(
      /no send kind/,
    );
    expect(provider.sent).toHaveLength(0);
  });
});
