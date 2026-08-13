// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { FixtureEmailProvider } from "@/lib/email/fixture";
import type { EmailMessage, EmailProvider } from "@/lib/email/provider";
import { RESEND_ENDPOINT, ResendProvider } from "@/lib/email/resend";

// `resend.ts` is `server-only` — the marker that makes a client-component
// import a BUILD failure. Under vitest it is a module that throws on import,
// stubbed here exactly the way `capture-route.test.ts` stubs it.
vi.mock("server-only", () => ({}));

/**
 * The provider seam (#203): the Resend implementation against a stubbed fetch
 * — no test in this repo talks to a real mail provider — and the fixture twin
 * held to the same semantics. The outcome mapping is the part under test,
 * because it is the part a review should attack: nothing but a 2xx WITH a
 * message id may ever read as success.
 */

const MESSAGE: EmailMessage = {
  to: "person@example.com",
  subject: "Your Job Search HQ account is active",
  text: "Your account is active.",
  html: "<p>Your account is active.</p>",
};

const ENV = { apiKey: "re_test_not_a_real_key", sender: "Job Search HQ <hq@example.com>" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ResendProvider", () => {
  it("POSTs the message to the one endpoint with the bearer key and returns the id", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { id: "re-msg-1" }),
    );
    const provider = new ResendProvider(ENV, fetchImpl);

    const outcome = await provider.send(MESSAGE);

    expect(outcome).toEqual({ ok: true, providerMessageId: "re-msg-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ENV.apiKey}`,
    );
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      from: ENV.sender,
      to: ["person@example.com"],
      subject: MESSAGE.subject,
    });
  });

  it("a 4xx is failed with the provider's own words — never a success row", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { name: "validation_error", message: "Domain is not verified" }),
    );
    const provider = new ResendProvider(ENV, fetchImpl);

    const outcome = await provider.send(MESSAGE);

    expect(outcome).toEqual({
      ok: false,
      outcome: "failed",
      reason: "resend 403: validation_error: Domain is not verified",
    });
  });

  it("a 5xx with an unreadable body is still a named failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const provider = new ResendProvider(ENV, fetchImpl);

    expect(await provider.send(MESSAGE)).toEqual({
      ok: false,
      outcome: "failed",
      reason: "resend 502",
    });
  });

  it("a 2xx WITHOUT a message id is unknown, not sent: no forged provider evidence", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepted: true }));
    const provider = new ResendProvider(ENV, fetchImpl);

    const outcome = await provider.send(MESSAGE);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.outcome).toBe("unknown");
      expect(outcome.reason).toContain("without a message id");
    }
  });

  it("a fetch that dies unanswered is unknown: the request may or may not have left", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.resend.com");
    });
    const provider = new ResendProvider(ENV, fetchImpl);

    const outcome = await provider.send(MESSAGE);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.outcome).toBe("unknown");
      expect(outcome.reason).toContain("resend unreachable");
    }
  });
});

describe("the fixture twin", () => {
  it("implements the same interface with the same success shape and zero network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fixture: EmailProvider = new FixtureEmailProvider();

    const outcome = await fixture.send(MESSAGE);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.providerMessageId).toBe("fixture-1");
    expect(fixture.name).toBe("fixture");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("records the rendered artifact for assertions, in order", async () => {
    const fixture = new FixtureEmailProvider();
    await fixture.send(MESSAGE);
    await fixture.send({ ...MESSAGE, to: "second@example.com" });
    expect(fixture.sent.map((m) => m.to)).toEqual(["person@example.com", "second@example.com"]);
  });

  it("can refuse like the real thing, because a fake that only succeeds proves nothing", async () => {
    const fixture = new FixtureEmailProvider();
    fixture.refuseWith = { ok: false, outcome: "failed", reason: "resend 403: nope" };
    const outcome = await fixture.send(MESSAGE);
    expect(outcome).toEqual({ ok: false, outcome: "failed", reason: "resend 403: nope" });
    expect(fixture.sent).toHaveLength(0);
  });
});
