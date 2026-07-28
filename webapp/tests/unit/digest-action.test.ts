// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { digestGet, digestPost } from "@/lib/digest/handler";
import type {
  DigestPostingView,
  DigestStore,
  DigestTriageInput,
  DigestWriteOutcome,
} from "@/lib/digest/store";
import { mintDigestToken, PURPOSE_UNDO, UNDO_ACTION, verifyDigestToken } from "@/lib/digest/token";

/**
 * `/d/<token>`, driven with real `Request`s through the real handler.
 *
 * NODE ENVIRONMENT: the handler reads a `ReadableStream` off `request.body` and
 * calls `node:crypto`. jsdom's `Request` is not the one it parses, and a route
 * tested through a stand-in body is a route tested against a fake of the thing
 * under test (`capture-route.test.ts` and `import-upload-route.test.ts` say the
 * same, for the same reason).
 *
 * The store is a fake because 0019's own semantics are executed for real in
 * `tests/db/test_digest_action.py` against Postgres. What is under test HERE is
 * the handler: which verb writes, which page each situation renders, and what
 * every response carries whatever it renders.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE TEST THIS FILE EXISTS FOR
 *
 * "GET renders, twice, and the fake recorded zero writes." Outlook ATP Safe
 * Links, Proofpoint and Mimecast GET every link in an email before a human sees
 * it, so a GET that mutates triages the whole digest the moment it lands
 * (`docs/plans/PHASE-DIGEST.md` §3.2, matrix row 25). The assertion is on the
 * FAKE's counters rather than on a response body, because "the page looked right"
 * is exactly what a mutating GET also produces.
 *
 * MUTATION TARGETS — each run red before green:
 *   * `digestGet` calls `setTriage`          -> "two GETs write nothing"
 *   * drop the `idem: payload.jti` argument  -> "three POSTs, one write"
 *   * `postingForUser(userId, …)` -> a read that ignores the user
 *                                            -> "A's token cannot see B's posting"
 *   * let a P0002 throw instead of answering `missing`
 *                                            -> "a posting the user does not have"
 *   * drop the closed-status check           -> "a closed posting is not offered"
 *   * drop any one of the three headers      -> "every response carries them"
 *   * render the posting fields unescaped    -> "a hostile company name"
 */

// The handler reaches `lib/supabase/service.ts` and `lib/http/bounded.ts`, both
// `server-only` — the marker that makes a client-component import a BUILD
// failure. Under vitest it is a module that throws on import, so it is stubbed
// exactly the way `capture-route.test.ts` stubs it.
// `service-key-containment.test.ts` is what keeps the marker meaningful.
vi.mock("server-only", () => ({}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GOLDEN = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "digest-token.golden.json"), "utf8"),
) as { keys_env: string };

const KEYS_BEFORE = process.env.HQ_DIGEST_KEYS;
process.env.HQ_DIGEST_KEYS = GOLDEN.keys_env;
afterAll(() => {
  if (KEYS_BEFORE === undefined) delete process.env.HQ_DIGEST_KEYS;
  else process.env.HQ_DIGEST_KEYS = KEYS_BEFORE;
});

const ALICE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BOB = "22222222-2222-2222-2222-222222222222";
const KEY = "greenhouse-4012345";

/**
 * A `DigestStore` that behaves the way 0019 behaves — including where it refuses.
 *
 * "A fake must reproduce the real thing's failure modes, not just its happy path"
 * (`docs/WEBAPP-BUILD.md`), and the three that matter here are the three the
 * function's own tests are about: a replay under a seen idempotency key returns
 * the FIRST answer and writes nothing, a gesture that changes nothing writes
 * nothing, and a posting this user does not have is an OUTCOME rather than an
 * exception (0019 raises P0002; `SupabaseDigestStore` turns it into `missing`, and
 * a fake that threw instead would let the handler's 500 go unnoticed).
 */
class FakeDigestStore implements DigestStore {
  readonly rows = new Map<string, DigestPostingView>();
  readonly idem = new Map<string, DigestWriteOutcome>();
  /** Calls to the read. */
  reads = 0;
  /** Calls to the RPC, whether or not they changed anything. */
  setCalls = 0;
  /** Calls that actually CHANGED a row. The number row 25 and row 26 are about. */
  writes = 0;
  /** Calls answered from the idempotency map rather than by looking at the row. */
  replays = 0;
  /** Every idempotency key the handler has passed, in order. */
  readonly idemSeen: string[] = [];
  failNextRead: string | null = null;
  failNextWrite: string | null = null;

  add(userId: string, over: Partial<DigestPostingView> = {}): DigestPostingView {
    const row: DigestPostingView = {
      postingKey: KEY,
      company: "Ramp",
      title: "Product Manager",
      location: "New York, NY",
      url: "https://boards.greenhouse.io/ramp/jobs/1",
      status: "Seen",
      triage: "",
      ...over,
    };
    this.rows.set(`${userId} ${row.postingKey}`, row);
    return row;
  }

  async postingForUser(userId: string, postingKey: string): Promise<DigestPostingView | null> {
    this.reads += 1;
    if (this.failNextRead) {
      const why = this.failNextRead;
      this.failNextRead = null;
      throw new Error(why);
    }
    const row = this.rows.get(`${userId} ${postingKey}`);
    return row ? { ...row } : null;
  }

  async setTriage(input: DigestTriageInput): Promise<DigestWriteOutcome> {
    this.setCalls += 1;
    if (this.failNextWrite) {
      const why = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(why);
    }
    this.idemSeen.push(input.idem);
    const replay = this.idem.get(`${input.userId} ${input.idem}`);
    if (replay) {
      this.replays += 1;
      return replay;
    }

    const row = this.rows.get(`${input.userId} ${input.postingKey}`);
    // 0019 raises `no such posting for this user` and the store maps it. Nothing
    // is recorded under the idempotency key, because nothing happened.
    if (!row) return { outcome: "missing" };

    // 0019 refuses a Closed posting too (C3 review M1), same errcode as not-found
    // -> the store maps it to `missing`. A fake more forgiving than the real
    // function hides exactly the bug the SQL guard exists to catch.
    if (row.status === "Closed") return { outcome: "missing" };

    if (row.triage !== input.triage) {
      row.triage = input.triage;
      this.writes += 1;
    }
    const result: DigestWriteOutcome = {
      outcome: "applied",
      triage: row.triage,
      posting: { ...row },
    };
    this.idem.set(`${input.userId} ${input.idem}`, result);
    return result;
  }
}

let store: FakeDigestStore;

beforeEach(() => {
  store = new FakeDigestStore();
});

function token(
  over: { userId?: string; postingKey?: string; action?: "interested" | "dismissed" } = {},
  ageDays = 0,
): string {
  return mintDigestToken(
    {
      userId: over.userId ?? ALICE,
      postingKey: over.postingKey ?? KEY,
      action: over.action ?? "interested",
    },
    { now: Date.now() - ageDays * 86400_000 },
  );
}

function undoToken(userId = ALICE, postingKey = KEY): string {
  return mintDigestToken(
    { userId, postingKey, action: UNDO_ACTION, purpose: PURPOSE_UNDO },
    {},
  );
}

function post(tok: string, init: RequestInit = {}): Promise<Response> {
  return digestPost(new Request(`http://localhost/d/${tok}`, { method: "POST", ...init }), tok, store);
}

/** The three that ride on every response, whatever it renders. */
function expectSafeHeaders(response: Response): void {
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
}

describe("GET never writes — matrix row 25", () => {
  it("renders the confirmation and writes NOTHING, twice", async () => {
    store.add(ALICE);
    const tok = token();

    // The first GET is Outlook ATP Safe Links, before a human has seen the mail.
    const scanner = await digestGet(tok, store);
    expect(scanner.status).toBe(200);
    // The second is the person, minutes or days later.
    const human = await digestGet(tok, store);
    expect(human.status).toBe(200);

    // THE ASSERTION THIS FILE EXISTS FOR. Not "the page looked right" — a
    // mutating GET produces a page that looks right too.
    expect(store.setCalls).toBe(0);
    expect(store.writes).toBe(0);
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("");

    const body = await human.text();
    expect(body).toContain('<form method="post"');
    expect(body).toContain("Yes, I&#39;m interested");
    expect(body).toContain("Ramp");
    expect(body).toContain("Product Manager");
  });

  it("offers a tap target that is not a hairline", async () => {
    store.add(ALICE);
    const body = await (await digestGet(token(), store)).text();
    // 44x44 is the floor; the button is full width and 48px tall. The rendered
    // page is opened on a phone in a mail client, where a 20px link is a misclick
    // and a misclick is a wrong decision.
    expect(body).toMatch(/min-height:48px/);
    expect(body).toMatch(/width:100%/);
  });

  it("names the token's action, not the other one", async () => {
    store.add(ALICE);
    const body = await (await digestGet(token({ action: "dismissed" }), store)).text();
    expect(body).toContain("Hide this one?");
    expect(body).not.toContain("Yes, I&#39;m interested");
  });
});

describe("POST is the only thing that writes", () => {
  it("applies the token's action exactly once", async () => {
    store.add(ALICE);
    const response = await post(token());
    expect(response.status).toBe(200);
    expect(store.setCalls).toBe(1);
    expect(store.writes).toBe(1);
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("interested");
    const body = await response.text();
    expect(body).toContain("in your pipeline");
    expect(body).toContain("Undo");
  });

  it("three POSTs of the same token: ONE write, then the recorded outcome", async () => {
    // Matrix row 26. The same emailed link clicked again next week must not
    // produce a second application and a second audit event — the token's `jti`
    // is the idempotency key, and the replay returns what the first call
    // returned.
    store.add(ALICE);
    const tok = token();
    const bodies: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await post(tok);
      expect(response.status).toBe(200);
      bodies.push(await response.text());
    }
    expect(store.setCalls).toBe(3);
    expect(store.writes).toBe(1);
    // AND it is the IDEMPOTENCY KEY doing that, not the no-op short circuit
    // behind it. Without this pair the handler could hand the store a fresh
    // random key every time and still look right here — the row happens to
    // already carry the value, so nothing changes twice. What the store would
    // have lost is the replay, and with it the "already saved" answer and the
    // one-event guarantee that row 26 is actually about.
    expect(store.replays).toBe(2);
    const verdict = verifyDigestToken(tok, {});
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(store.idemSeen).toEqual([verdict.payload.jti, verdict.payload.jti, verdict.payload.jti]);
    // The recorded outcome, not a fresh read: all three say the same thing about
    // what happened.
    for (const body of bodies) expect(body).toContain("in your pipeline");
  });

  it("dismisses when that is what the link was signed for", async () => {
    store.add(ALICE);
    await post(token({ action: "dismissed" }));
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("dismissed");
  });

  it("bounds the body it never reads", async () => {
    // The form has no fields; the token is in the path. The read is bounded
    // anyway, because anybody who finds this URL can POST to it and an unbounded
    // read is an allocation they get to ask for.
    store.add(ALICE);
    const huge = "x".repeat(5000);
    const declared = await post(token(), {
      headers: { "content-length": String(huge.length) },
      body: huge,
    });
    expect(declared.status).toBe(413);
    expectSafeHeaders(declared);
    expect(store.setCalls).toBe(0);
  });

  it("accepts the fieldless body the page actually submits", async () => {
    store.add(ALICE);
    expect((await post(token())).status).toBe(200);
    expect((await post(token(), { body: "" })).status).toBe(200);
  });
});

describe("undo", () => {
  it("clears the triage and stops offering itself", async () => {
    const row = store.add(ALICE, { triage: "interested" });
    const response = await post(undoToken());
    expect(response.status).toBe(200);
    expect(row.triage).toBe("");
    const body = await response.text();
    expect(body).toContain("Undone");
    // Nothing left to undo, so no button that would report success for doing
    // nothing.
    expect(body).not.toContain(">Undo<");
  });

  it("is a FRESH token on the success page, never the original replayed", async () => {
    // The original is by then a known-used value that may be sitting in a proxy
    // log (PHASE-DIGEST §3.3).
    store.add(ALICE);
    const tok = token();
    const body = await (await post(tok)).text();
    const action = /action="\/d\/([^"]+)"/.exec(body);
    expect(action).not.toBeNull();
    expect(action?.[1]).not.toBe(tok);
  });
});

describe("already decided", () => {
  it("says which decision won and offers the reverse in one tap", async () => {
    store.add(ALICE, { triage: "dismissed" });
    // The person taps the Interested link on a row they already dismissed.
    const body = await (await digestGet(token({ action: "interested" }), store)).text();
    expect(body).toContain("You already marked this Not for me.");
    expect(body).toContain("Change to Interested");
    expect(store.writes).toBe(0);
  });

  it("offers Undo when the decision that won is the one this link asks for", async () => {
    store.add(ALICE, { triage: "interested" });
    const body = await (await digestGet(token({ action: "interested" }), store)).text();
    expect(body).toContain("You already marked this Interested.");
    expect(body).toContain(">Undo<");
    expect(store.writes).toBe(0);
  });

  it("offers a FRESH token, never the tapped one — the tapped one may be spent", async () => {
    // C3 review M2. The original interested token, tapped once, is BURNT: a
    // replay of it returns the first answer and writes nothing. So the reverse
    // offered on an already-decided page must be a new jti, or the button does
    // nothing and the success page lies. Assert the offered token is not the one
    // that was tapped AND that POSTing it actually flips the row.
    store.add(ALICE, { triage: "dismissed" });
    const tapped = token({ action: "interested" });
    const body = await (await digestGet(tapped, store)).text();
    const offered = /action="\/d\/([^"]+)"/.exec(body)?.[1];
    expect(offered).toBeTruthy();
    expect(offered).not.toBe(tapped);

    const flipped = await post(offered as string);
    expect((await flipped.text())).toContain("Saved");
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("interested"); // it really changed
  });
});

describe("a replayed token tells the truth about the row — C3 review M2", () => {
  it("renders the row's CURRENT state, not the stored first answer", async () => {
    // Tap Interested (jti_A) -> interested. Tap Not-for-me (jti_B) -> dismissed.
    // Tap the Interested email link (jti_A) AGAIN: setTriage replays jti_A and
    // returns its stored `interested` snapshot, but the row is dismissed. The
    // page must read the live row and say so, not render "Saved ... in your
    // pipeline" over a decision the row does not have.
    store.add(ALICE);
    const interested = token({ action: "interested" });
    const dismissed = token({ action: "dismissed" });

    await post(interested); // -> interested
    await post(dismissed); //  -> dismissed
    const writesBefore = store.writes;

    const replay = await post(interested); // replay of a used jti; row is dismissed
    expect(replay.status).toBe(200);
    const body = await replay.text();
    expect(body).toContain("You already marked this Not for me."); // the truth
    expect(body).not.toContain("is in your pipeline"); // NOT a fresh success
    expect(store.replays).toBeGreaterThan(0); // it really was a replay
    expect(store.writes).toBe(writesBefore); // nothing written
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("dismissed"); // row unmoved
  });

  it("a plain double-tap of the same link still reads as a clean success", async () => {
    // The control the M2 fix must not break: tap Interested twice, nothing else.
    // The replay returns interested, the row IS interested, so "Saved" is TRUE.
    store.add(ALICE);
    const tok = token({ action: "interested" });
    await post(tok);
    const again = await post(tok);
    const body = await again.text();
    expect(body).toContain("Saved");
    expect(body).toContain("is in your pipeline");
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("interested");
  });
});

describe("the posting is gone — rows 40 and 41", () => {
  it("A's token cannot see a posting only B has, and writes nothing", async () => {
    // Row 40: the user comes from the SIGNED TOKEN, never from a query
    // parameter, and the read is scoped to that user's user_postings. A read of
    // `postings` alone would have handed the company and the title to whoever
    // held the link.
    store.add(BOB);
    const tok = token({ userId: ALICE });

    const get = await digestGet(tok, store);
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(body).toContain("no longer listed");
    expect(body).not.toContain("Ramp");

    const wrote = await post(tok);
    expect(wrote.status).toBe(200);
    expect(await wrote.text()).toContain("no longer listed");
    expect(store.writes).toBe(0);
    expect(store.rows.get(`${BOB} ${KEY}`)?.triage).toBe("");
  });

  it("a closed posting renders 'no longer listed' rather than a 500, on GET AND POST", async () => {
    // Row 41 and C3 review M1: the board closed it between the send and the tap.
    // GET already said "no longer listed"; POST has to AGREE — before this fix it
    // went straight to setTriage and created a `Queued` application for a dead
    // listing. Both verbs refuse, and the POST never reaches the RPC.
    store.add(ALICE, { status: "Closed" });

    const got = await digestGet(token(), store);
    expect(got.status).toBe(200);
    expect(await got.text()).toContain("no longer listed");

    const posted = await post(token());
    expect(posted.status).toBe(200);
    expect(await posted.text()).toContain("no longer listed");
    expect(store.setCalls).toBe(0); // the route refused before the write
    expect(store.writes).toBe(0);
    expect(store.rows.get(`${ALICE} ${KEY}`)?.triage).toBe("");
  });
});

describe("tokens this page refuses", () => {
  it("gives ONE generic sentence for a forged token, and touches no store", async () => {
    const tampered = JSON.parse(
      readFileSync(path.join(REPO, "tests", "fixtures", "digest-token.golden.json"), "utf8"),
    ) as { tampered_action_token: string };
    store.add(ALICE);
    for (const bad of [tampered.tampered_action_token, "nonsense", ""]) {
      const response = await digestGet(bad, store);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("isn&#39;t valid any more");
    }
    // Not even a READ: a page that looked something up would answer "how long did
    // that take" for a token nobody should be able to ask questions with.
    expect(store.reads).toBe(0);
    expect(store.setCalls).toBe(0);
  });

  it("names the posting on an expired link, and still writes nothing", async () => {
    // The expired page is deliberately NOT the invalid page: three weeks later
    // the email should still tell the person what it was about, and that is only
    // safe because the signature checked out.
    store.add(ALICE);
    const stale = token({}, 8);
    const get = await digestGet(stale, store);
    expect(get.status).toBe(410);
    const body = await get.text();
    expect(body).toContain("This link expired on");
    expect(body).toContain("Ramp");

    const wrote = await post(stale);
    expect(wrote.status).toBe(410);
    expect(store.setCalls).toBe(0);
    expect(store.writes).toBe(0);
  });
});

describe("a store that is not answering", () => {
  it("says try again rather than 500ing, on both verbs", async () => {
    store.add(ALICE);
    store.failNextRead = "connection refused";
    const get = await digestGet(token(), store);
    expect(get.status).toBe(503);
    expect(await get.text()).toContain("Nothing changed");

    store.failNextWrite = "deadlock detected";
    const wrote = await post(token());
    expect(wrote.status).toBe(503);
    expect(store.writes).toBe(0);
  });
});

describe("what every response carries", () => {
  it("the three headers, on all six states and the refusals", async () => {
    store.add(ALICE);
    const responses = [
      await digestGet(token(), store), // confirm
      await post(token()), // done
      await digestGet(token(), store), // already decided
      await digestGet(token({ userId: BOB }), store), // gone
      await digestGet(token({}, 8), store), // expired
      await digestGet("nonsense", store), // invalid
      await post(token(), { headers: { "content-length": "9999" }, body: "x".repeat(9999) }), // 413
    ];
    expect(responses).toHaveLength(7);
    for (const response of responses) expectSafeHeaders(response);
    // The HTML ones say so, which is what makes a mail client render them rather
    // than download them.
    for (const response of responses.slice(0, 6)) {
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
  });

  it("no service key, no store credential and no secret in any rendered byte", async () => {
    store.add(ALICE, { company: "Ramp" });
    const bodies = [
      await (await digestGet(token(), store)).text(),
      await (await post(token())).text(),
      await (await digestGet("nonsense", store)).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain(GOLDEN.keys_env.split(":")[1]);
      expect(body).not.toMatch(/SUPABASE|SERVICE_KEY|HQ_DIGEST_KEYS/);
    }
  });
});

describe("the posting fields are escaped", () => {
  it("a hostile company name renders as text", async () => {
    // Every one of these came off an ATS adapter's JSON, and the page is built by
    // string concatenation — the construction that turns one unescaped field into
    // script execution.
    store.add(ALICE, { company: '<script>alert(1)</script>', title: 'PM " onload="x' });
    const body = await (await digestGet(token(), store)).text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("PM &quot; onload=&quot;x");
  });

  it("a javascript: posting URL is dropped rather than linked", async () => {
    store.add(ALICE, { url: "javascript:alert(1)" });
    const body = await (await digestGet(token(), store)).text();
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("View the posting");
  });

  it("a userinfo URL is dropped — the host is not the part a reader sees", async () => {
    store.add(ALICE, { url: "https://www.google.com@evil.example/jobs/1" });
    const body = await (await digestGet(token(), store)).text();
    expect(body).not.toContain("evil.example");
  });
});
