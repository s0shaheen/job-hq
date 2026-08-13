// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEmailDispatch } from "@/lib/email/handler";
import { FixtureEmailProvider, FixtureEmailStore } from "@/lib/email/fixture";
import type { PendingLifecycleSend } from "@/lib/email/store";

// The handler reaches `lib/email/resend.ts` and `lib/supabase/service.ts`,
// both `server-only`. Under vitest that marker throws on import, so it is
// stubbed here exactly the way `capture-route.test.ts` stubs it.
vi.mock("server-only", () => ({}));

/**
 * `/api/email/dispatch` driven with real `Request`s (#203) — the capture
 * route's testing shape. What is under test is the boundary: who may call it,
 * what an unconfigured deployment answers, and that the flag-off path is a
 * recorded loud skip rather than a 200 that did nothing quietly.
 */

const SECRET = "test-dispatch-secret";

function request(auth?: string): Request {
  return new Request("http://localhost/api/email/dispatch", {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
}

function pendingItem(): PendingLifecycleSend {
  return {
    sendKey: "evt:1",
    userId: "00000000-0000-4000-8000-000000000001",
    eventKind: "entitlement.activated",
    email: "person@example.com",
    name: "Avery Example",
    occurredAt: "2026-08-13T00:00:00Z",
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/email/dispatch", () => {
  it("answers 503 when no dispatch secret is configured — unconfigured is closed, not open", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await handleEmailDispatch(request(`Bearer anything`), new FixtureEmailStore(), null);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("dispatch secret");
  });

  it("answers 401 for a missing, malformed, or wrong bearer — one answer, no oracle", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const auth of [undefined, "Basic abc", `Bearer wrong-${SECRET}`, "Bearer "]) {
      const res = await handleEmailDispatch(request(auth), new FixtureEmailStore(), null);
      expect(res.status, String(auth)).toBe(401);
      expect((await res.json()).error).toBe("Unauthorized.");
    }
  });

  it("with the flag off, dispatches to skipped rows and SAYS it is disabled", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_SENDER", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new FixtureEmailStore();
    store.seedPending([pendingItem()]);

    const res = await handleEmailDispatch(request(`Bearer ${SECRET}`), store);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ considered: 1, skipped: 1, sent: 0 });
    expect(body.disabled).toContain("RESEND_API_KEY");
    expect(store.row("evt:1")?.status).toBe("skipped");
    expect(store.row("evt:1")?.reason).toContain("RESEND_API_KEY");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SKIPPED"));
  });

  it("with a provider, sends and reports the summary with no addresses in the response", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    store.seedPending([pendingItem()]);

    const res = await handleEmailDispatch(request(`Bearer ${SECRET}`), store, provider);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ considered: 1, sent: 1, disabled: "" });
    expect(JSON.stringify(body)).not.toContain("person@example.com");
    expect(provider.sent).toHaveLength(1);
  });

  it("refuses loudly on a configured-but-unsafe EMAIL_APP_URL instead of dropping the link forever", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("EMAIL_APP_URL", "https://user@example.com/");
    const res = await handleEmailDispatch(
      request(`Bearer ${SECRET}`),
      new FixtureEmailStore(),
      new FixtureEmailProvider(),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("EMAIL_APP_URL");
  });

  it("a safe EMAIL_APP_URL reaches the activation template", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("EMAIL_APP_URL", "https://hq.example.com/");
    const store = new FixtureEmailStore();
    const provider = new FixtureEmailProvider();
    store.seedPending([pendingItem()]);

    const res = await handleEmailDispatch(request(`Bearer ${SECRET}`), store, provider);

    expect(res.status).toBe(200);
    expect(provider.sent[0].text).toContain("Sign in: https://hq.example.com/");
  });
});
