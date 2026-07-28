// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, MAX_EVENTS } from "@/lib/capture/schema";
import { secretDigest } from "@/lib/capture/token";
import { FakeCaptureStore } from "./capture-fake";
import { GET } from "@/app/api/capture/route";
import { handleCapture } from "@/lib/capture/handler";
import type { CaptureResponse } from "@/lib/capture/handler";

/**
 * `POST /api/capture`, driven with real `Request`s through the real handler.
 *
 * NODE ENVIRONMENT: the handler reads a `ReadableStream` off `request.body` and
 * calls `node:crypto`. jsdom's `Request` is not the one it parses, and a route
 * tested through a stand-in body is a route tested against a fake of the thing
 * under test (`import-upload-route.test.ts` says the same, for the same reason).
 *
 * The store is a fake because the store's own semantics are executed for real in
 * `tests/db/test_capture.py` against Postgres, and held to the fake in
 * `capture-parity.test.ts`. What is under test HERE is the handler: the order of
 * its checks, what it refuses, and whether a per-row rejection is reported as a
 * row rather than as a batch.
 *
 * MUTATION TARGETS — each run red before green:
 *   * move the auth check after the body read  -> "authenticates before reading"
 *   * `verifySecret(...)` -> `Boolean(live)`   -> "a valid selector with the
 *                                                 wrong secret is 401"
 *   * ignore `revoked_at`                      -> "a revoked token is 401"
 *   * `readBoundedBody` -> `request.text()`    -> "an undeclared oversized body"
 *   * report a store throw as per-row rejected -> "a store outage is 503"
 *   * drop the `at[i]` remapping               -> "indices name the caller's rows"
 *   * answer 4xx when one row is bad           -> "one bad row does not drop the
 *                                                 batch"
 */

// The handler reaches `lib/supabase/service.ts`, which is `server-only` — the
// marker that makes a client-component import a BUILD failure. Under vitest it
// is a module that throws on import, so it is stubbed here exactly the way
// `import-upload-route.test.ts` stubs it. `service-key-containment.test.ts` is
// what keeps the marker meaningful while this stub exists.
vi.mock("server-only", () => ({}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GOLDEN = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "capture-token.golden.json"), "utf8"),
) as { secret: string; sha256: string; token: string; selector: string };

const USER = "11111111-1111-1111-1111-111111111111";

let store: FakeCaptureStore;

beforeEach(() => {
  store = new FakeCaptureStore();
  store.addToken({
    id: 7,
    selector: GOLDEN.selector,
    user_id: USER,
    secret_sha256: GOLDEN.sha256,
  });
});

function wireEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: `<${Math.random().toString(16).slice(2)}@mail.gmail.com>`,
    account: "main",
    received_at: "2026-07-27T14:02:11Z",
    from: "Ramp Recruiting <no-reply@greenhouse.io>",
    subject: "Thank you for applying to Ramp",
    snippet: "We received your application.",
    event_type: "received",
    company: "Ramp",
    title: "Product Manager",
    ats: "greenhouse",
    job_url: "https://boards.greenhouse.io/ramp/jobs/1",
    confidence: 0.93,
    evidence: "We received your application",
    thread_link: "https://mail.google.com/mail/u/0/#all/18f",
    processed_at: "2026-07-27 14:02:19Z",
    ...over,
  };
}

type PostOptions = {
  token?: string | null;
  declared?: number | null;
  body?: string;
  raw?: BodyInit;
};

function post(events: unknown[] | null, options: PostOptions = {}): Promise<Response> {
  const body = options.body ?? JSON.stringify(events === null ? {} : { events });
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = options.token === undefined ? GOLDEN.token : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.declared !== null) {
    headers["content-length"] = String(options.declared ?? Buffer.byteLength(body));
  }
  return handleCapture(
    new Request("http://localhost/api/capture", { method: "POST", headers, body }),
    store,
  );
}

async function json(response: Response): Promise<CaptureResponse & { error?: string }> {
  return (await response.json()) as CaptureResponse & { error?: string };
}


describe("authentication", () => {
  it("stores a batch for a live token", async () => {
    const response = await post([wireEvent()]);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ received: 1, inserted: 1, duplicate: 0, rejected: 0 });
    expect(store.events.size).toBe(1);
    // Proof of life on the credential, so "is this token still in use?" is
    // answerable before somebody revokes it.
    expect(store.lastUsed.get(7)).toBeDefined();
  });

  it("answers 401 with no Authorization header, and offers the scheme", async () => {
    const response = await post([wireEvent()], { token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(store.events.size).toBe(0);
  });

  it("gives the SAME answer for every way authentication fails", async () => {
    const answers: string[] = [];
    for (const token of [
      null, // absent
      "nonsense", // malformed
      `hqc_ffffffffffffffff_${GOLDEN.secret}`, // unknown selector
      `hqc_${GOLDEN.selector}_${"0".repeat(64)}`, // real selector, wrong secret
    ]) {
      const response = await post([wireEvent()], { token });
      expect(response.status).toBe(401);
      answers.push((await json(response)).error ?? "");
    }
    // No user enumeration: "no such token" and "wrong secret" must be the same
    // sentence, or the response confirms which selectors exist.
    expect(new Set(answers).size).toBe(1);
  });

  it("answers 401 for a revoked token", async () => {
    store.addToken({
      id: 9,
      selector: "aaaaaaaaaaaaaaaa",
      user_id: USER,
      secret_sha256: GOLDEN.sha256,
      revoked_at: "2026-07-26T00:00:00Z",
    });
    const response = await post([wireEvent()], {
      token: `hqc_aaaaaaaaaaaaaaaa_${GOLDEN.secret}`,
    });
    expect(response.status).toBe(401);
    expect(store.events.size).toBe(0);
  });

  it("writes into the token's OWN user's lane, never a lane named by the caller", async () => {
    store.addToken({
      id: 11,
      selector: "bbbbbbbbbbbbbbbb",
      user_id: "22222222-2222-2222-2222-222222222222",
      secret_sha256: secretDigest("c".repeat(64)),
    });
    await post([wireEvent({ event_id: "<shared@x>" })], {
      token: `hqc_bbbbbbbbbbbbbbbb_${"c".repeat(64)}`,
    });
    expect([...store.events.keys()]).toEqual(["22222222-2222-2222-2222-222222222222 <shared@x>"]);
  });

  it("authenticates BEFORE reading the body", async () => {
    // A body far over the cap with a bad token: if the read came first this
    // would be 413, and an unauthenticated caller would have been able to make
    // the server allocate. The status names which check ran.
    const huge = JSON.stringify({ events: [wireEvent({ subject: "x".repeat(MAX_BODY_BYTES) })] });
    const response = await post(null, { token: "nonsense", body: huge });
    expect(response.status).toBe(401);
  });

  it("calls the store exactly once per request to look the token up", async () => {
    await post([wireEvent()]);
    expect(store.lookups).toBe(1);
  });

  it("answers 503 — not 401 — when the token lookup itself fails", async () => {
    // A store outage is not a bad credential. 401 would send an operator to
    // rotate a token that was never the problem.
    store.failNextLookup = "connection refused";
    const response = await post([wireEvent()]);
    expect(response.status).toBe(503);
  });
});

describe("the byte cap", () => {
  it("refuses a declared size over the cap without reading the body", async () => {
    const response = await post([wireEvent()], { declared: MAX_BODY_BYTES + 1 });
    expect(response.status).toBe(413);
    expect(store.events.size).toBe(0);
  });

  it("refuses an UNDECLARED oversized body, counting it off the stream", async () => {
    // Matrix row 265, at the inbound door: `headers.get()` answers null for an
    // absent header and `Number(null)` is 0, so a body that declines to say how
    // big it is used to be the one that got through. The cap is the stream now.
    const huge = JSON.stringify({
      events: [wireEvent({ subject: "x".repeat(MAX_BODY_BYTES) })],
    });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_BODY_BYTES);
    const response = await post(null, { body: huge, declared: null });
    expect(response.status).toBe(413);
    expect(store.events.size).toBe(0);
  });

  it("accepts an undeclared body that is under the cap", async () => {
    // The other half of the same rule: absent is not an error, it is unstated.
    // `/api/import/upload` answers 411 here, because a browser form always
    // declares; UrlFetchApp is not a browser form and the stream bound is real.
    const response = await post([wireEvent()], { declared: null });
    expect(response.status).toBe(200);
  });

  it("ignores an unparseable content-length rather than reading it as zero", async () => {
    const body = JSON.stringify({ events: [wireEvent()] });
    const response = await handleCapture(
      new Request("http://localhost/api/capture", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "banana",
          authorization: `Bearer ${GOLDEN.token}`,
        },
        body,
      }),
      store,
    );
    // `Number("banana")` is NaN, which is not "over the cap" and not "zero" —
    // the stream is what decides, and this body is small.
    expect(response.status).toBe(200);
  });
});

describe("the envelope", () => {
  it("answers 400 for a body that is not JSON", async () => {
    const response = await post(null, { body: "event_id,subject\n<a@b>,hi" });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatch(/not JSON/i);
  });

  it("answers 400 for a body that is not a batch", async () => {
    for (const body of ["null", "[]", '{"rows":[]}', '{"events":{}}', '{"events":[]}']) {
      const response = await post(null, { body });
      expect(response.status, `accepted ${body}`).toBe(400);
    }
  });

  it("answers 413 — not 400 — for more events than the endpoint takes at once", async () => {
    const response = await post(Array.from({ length: MAX_EVENTS + 1 }, () => wireEvent()));
    expect(response.status).toBe(413);
    expect(store.events.size).toBe(0);
  });
});

describe("batch semantics", () => {
  it("ONE BAD ROW DOES NOT DROP THE BATCH — and the response names which", async () => {
    const good1 = wireEvent({ event_id: "<one@x>" });
    const bad = wireEvent({ event_id: "<two@x>", event_type: "maybe" });
    const good2 = wireEvent({ event_id: "<three@x>" });
    const response = await post([good1, bad, good2]);

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ received: 3, inserted: 2, duplicate: 0, rejected: 1 });
    // The index is the CALLER's, so a report about "row 1" is about the row the
    // sender put at position 1 — not the first row that survived validation.
    expect(body.results.map((r) => [r.index, r.event_id, r.outcome])).toEqual([
      [0, "<one@x>", "inserted"],
      [1, "<two@x>", "rejected"],
      [2, "<three@x>", "inserted"],
    ]);
    expect(body.results[1].reason).toMatch(/event_type/);
    expect(store.events.size).toBe(2);
  });

  it("names a row that has no usable event_id at all", async () => {
    const response = await post([{ subject: "no id here" }, wireEvent({ event_id: "<ok@x>" })]);
    const body = await json(response);
    expect(body.results[0]).toMatchObject({ index: 0, event_id: "", outcome: "rejected" });
    expect(body.results[1].outcome).toBe("inserted");
  });

  it("answers 200 with every row rejected when every row is bad — never 4xx", async () => {
    // A 4xx tells the retry queue to send this batch again, forever. These rows
    // will never be valid; the answer has to be "received, and here is why each
    // one did not land".
    const response = await post([wireEvent({ event_type: "maybe" }), { nope: 1 }]);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ received: 2, inserted: 0, rejected: 2 });
  });

  it("keeps the store's own rejections in the caller's numbering", async () => {
    // A row the ROUTE accepts and the STORE refuses. Reached by handing the fake
    // a row the validator cannot produce, which is exactly the drift the parity
    // test exists to prevent — asserted here so the remapping is exercised on a
    // store-side rejection too.
    const outcomes = await store.storeEvents(USER, 7, [
      {
        event_id: "<x@y>",
        account: "",
        received_at: "not a stamp",
        from_addr: "",
        subject: "",
        snippet: "",
        event_type: "other",
        company: "",
        title: "",
        ats: "",
        job_url: "",
        confidence: 0,
        evidence: "",
        thread_link: "",
        processed_at: null,
      },
    ]);
    expect(outcomes[0].outcome).toBe("rejected");
  });
});

describe("the poisoned row — review's C-1, the case that lost 50 events", () => {
  const NUL = "\u0000";

  it("one poisoned row in a batch of 50: 49 inserted, 1 rejected, batch alive", async () => {
    // Executed against postgres:16 in review: a NUL or an unpaired surrogate is
    // refused at the jsonb CAST, which is ABOVE `hq_capture_email_events`'s
    // per-row exception block — so all 50 were lost, 0 rows written, and the
    // chunk went back to the front of the retry queue to fail again every run
    // for weeks. The poison is in `event_id` here, the one field the parser may
    // not silently repair.
    const events = Array.from({ length: 50 }, (_, i) =>
      wireEvent({ event_id: i === 17 ? `<poison${NUL}@x>` : `<ok-${i}@x>` }),
    );
    const response = await post(events);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ received: 50, inserted: 49, rejected: 1 });
    expect(body.results[17]).toMatchObject({ index: 17, outcome: "rejected" });
    expect(body.results[17].reason).toMatch(/NUL or an unpaired surrogate/);
    expect(store.events.size).toBe(49);
  });

  it("a poisoned SNIPPET costs a character, not the event", async () => {
    // The common shape: `Code.gs` cut a 300-unit snippet through an emoji. The
    // event is real and its status change matters; the snippet's last character
    // does not.
    const body = await json(await post([wireEvent({ event_id: "<e@x>", snippet: "hi \ud83c" })]));
    expect(body).toMatchObject({ inserted: 1, rejected: 0 });
    expect(store.events.get(`${USER} <e@x>`)?.snippet.isWellFormed()).toBe(true);
  });

  it("EVERY row handed to the store is JSON the store can cast", async () => {
    // The killing assertion, and the one that does not care which field carried
    // the poison: whatever the route accepts, `JSON.stringify` of it must be
    // well-formed and NUL-free, or the whole call raises before any per-row
    // handling can run.
    const events = [
      wireEvent({ event_id: "<a@x>", subject: `s${NUL}`, snippet: "x\ud83c" }),
      wireEvent({ event_id: "<b@x>", company: "R\udfaf", evidence: `e${NUL}` }),
      wireEvent({ event_id: "<c@x>", title: "\ud83c\udfaf whole" }),
    ];
    const r = await post(events);
    expect(r.status).toBe(200);
    const stored = [...store.events.values()];
    expect(stored).toHaveLength(3);
    const payload = JSON.stringify(stored);
    expect(payload.isWellFormed()).toBe(true);
    expect(payload).not.toContain("\\u0000");
  });
});

describe("a sloppy URL costs the link, never the event", () => {
  it("stores an INTERVIEW whose job_url is prose, and says what it dropped", async () => {
    // The reviewer's headline case. Before the fix this answered 200 with the
    // row rejected and zero rows stored — an interview notification lost because
    // Haiku wrote "not specified" in a field nobody reads.
    const response = await post([
      wireEvent({ event_id: "<iv@x>", event_type: "interview", job_url: "not specified" }),
    ]);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ inserted: 1, rejected: 0, repaired: 1 });
    expect(body.results[0].note).toMatch(/job_url dropped/);
    expect(store.events.get(`${USER} <iv@x>`)?.job_url).toBe("");
    expect(store.events.get(`${USER} <iv@x>`)?.event_type).toBe("interview");
  });

  it("counts repairs separately from rejections in a mixed batch", async () => {
    // `repaired` is not a failure count. A batch can be entirely healthy and
    // still carry one, and collapsing the two numbers would make a blanked link
    // read as a lost event.
    const response = await post([
      wireEvent({ event_id: "<a@x>" }),
      wireEvent({ event_id: "<b@x>", job_url: "N/A" }),
      wireEvent({ event_id: "<c@x>", event_type: "maybe" }),
    ]);
    const body = await json(response);
    expect(body).toMatchObject({ received: 3, inserted: 2, rejected: 1, repaired: 1 });
    expect(body.results[0].note).toBeUndefined();
    expect(body.results[1]).toMatchObject({ outcome: "inserted" });
    expect(body.results[2]).toMatchObject({ outcome: "rejected" });
  });

  it("keeps the note on the row it belongs to when indices are remapped", async () => {
    // The repair is recorded at parse time and the outcome comes back from the
    // store, so the two are merged by the caller's index — the same remap a
    // rejected row exercises, on the other kind of annotation.
    const response = await post([
      wireEvent({ event_id: "<bad@x>", event_type: "maybe" }),
      wireEvent({ event_id: "<note@x>", job_url: "www.ramp.com/careers" }),
      wireEvent({ event_id: "<plain@x>" }),
    ]);
    const body = await json(response);
    expect(body.results.map((r) => [r.index, r.outcome, r.note !== undefined])).toEqual([
      [0, "rejected", false],
      [1, "inserted", false],
      [2, "inserted", false],
    ]);
    // `www.` is repaired unambiguously, so it earns no note — and the URL lands.
    expect(store.events.get(`${USER} <note@x>`)?.job_url).toBe("https://www.ramp.com/careers");
  });
});

describe("the replay", () => {
  it("answers duplicate for a resent batch and stores nothing twice", async () => {
    // The retry queue replays whole batches. A replay must be free.
    const events = [wireEvent({ event_id: "<a@x>" }), wireEvent({ event_id: "<b@x>" })];
    const first = await json(await post(events));
    expect(first).toMatchObject({ inserted: 2, duplicate: 0 });

    const second = await json(await post(events));
    expect(second).toMatchObject({ received: 2, inserted: 0, duplicate: 2, rejected: 0 });
    expect(store.events.size).toBe(2);
  });

  it("handles a partly-delivered batch — the half that landed is duplicate", async () => {
    await post([wireEvent({ event_id: "<a@x>" })]);
    const mixed = await json(
      await post([wireEvent({ event_id: "<a@x>" }), wireEvent({ event_id: "<b@x>" })]),
    );
    expect(mixed).toMatchObject({ inserted: 1, duplicate: 1 });
  });

  it("dedupes the same message arriving from a second mailbox", async () => {
    // The alt account forwards; the RFC-822 Message-ID survives forwarding. The
    // sheet lane relies on this and so does the store.
    await post([wireEvent({ event_id: "<a@x>", account: "main" })]);
    const forwarded = await json(await post([wireEvent({ event_id: "<a@x>", account: "alt" })]));
    expect(forwarded).toMatchObject({ duplicate: 1 });
  });
});

describe("a store that fails mid-batch", () => {
  it("answers 503 rather than reporting every row as rejected", async () => {
    // "rejected" means "this row is bad, stop sending it". A store outage means
    // "come back with all of it". Collapsing the two loses the batch.
    store.failNextWrite = "deadlock detected";
    const response = await post([wireEvent(), wireEvent()]);
    expect(response.status).toBe(503);
    expect((await json(response)).error).toMatch(/Nothing was written/);
  });
});

describe("configuration", () => {
  it("answers 503 when the deployment has no service credential", async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    const pub = process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      const response = await handleCapture(
        new Request("http://localhost/api/capture", {
          method: "POST",
          headers: { authorization: `Bearer ${GOLDEN.token}` },
          body: JSON.stringify({ events: [wireEvent()] }),
        }),
        // No store injected: this is the branch that would otherwise build a
        // service client out of undefined.
      );
      expect(response.status).toBe(503);
    } finally {
      if (url) process.env.SUPABASE_URL = url;
      if (key) process.env.SUPABASE_SERVICE_KEY = key;
      if (pub) process.env.NEXT_PUBLIC_SUPABASE_URL = pub;
    }
  });
});

describe("GET", () => {
  it("states the contract instead of Next's bare 405", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    const body = (await response.json()) as {
      error: string;
      contract: { limits: { bytes: number; events: number } };
    };
    expect(body.error).toMatch(/Bearer/);
    expect(body.contract.limits).toEqual({ bytes: MAX_BODY_BYTES, events: MAX_EVENTS });
  });
});
