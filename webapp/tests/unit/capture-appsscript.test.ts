// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { storable } from "@/lib/capture/schema";

/**
 * `appsscript/capture/Code.gs`'s own helpers, EXECUTED.
 *
 * This is the only file in the repo that runs Apps Script source. `Code.gs` is
 * pasted into script.google.com — no build, no typecheck, no runtime — and
 * `tests/core/test_capture_contract.py` can only read it as text. Text is enough
 * for a field list; it is not enough for `safeTruncate_`, whose entire job is an
 * off-by-one at a surrogate boundary.
 *
 * The pure helpers are extracted by name and evaluated. That is legitimate
 * precisely because they ARE pure: `safeTruncate_` touches no Google global, and
 * the Apps Script V8 runtime executes the same ECMAScript this Node does for the
 * constructs it uses (`String`, `.replace`, `.slice`, `.charCodeAt`).
 *
 * MUTATION TARGETS:
 *   * delete the high-surrogate trim  -> "never leaves half an emoji"
 *   * drop the NUL replace            -> "strips NUL"
 *   * `>= 0xD800` -> `> 0xD800`       -> the sweep, VIA U+10000. This line used
 *     to claim the boundary was covered "at U+1F3AF" and it was not: 🎯's high
 *     surrogate is 0xD83C, still `> 0xD800`, so the mutant behaved identically on
 *     every character in the corpus and survived a file advertising it. 0xD800 is
 *     the ONLY high surrogate the two comparisons disagree about, so the corpus
 *     has to contain a character that uses it — U+10000 does.
 *   * put a running count back in the latch key -> "one push per kind per day"
 *   * share one latch slot between the kinds    -> the same test
 *   * stamp the latch before the push, or ignore `ntfy_`'s status -> the
 *     500-then-200 tests: the lost day latches and the count is deleted
 *   * make `DIGEST_EMAIL_SOURCE` default to `engine`, or read it as an exact
 *     string match -> the digest switch tests
 *   * drop the `sent_at` check in engine mode -> "pushes when the engine did not"
 *   * revert ONE call site to .slice  -> `test_capture_contract.py`'s site check
 *     (source-shape, over there; this file proves the helper, that one proves it
 *     is the thing being called)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const CODE_GS = readFileSync(path.join(REPO, "appsscript", "capture", "Code.gs"), "utf8");

/** One named function's source, from `function NAME_(` to its balanced close. */
function extract(name: string): string {
  const at = CODE_GS.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`no function ${name}() in Code.gs — did it move?`);
  let depth = 0;
  for (let i = CODE_GS.indexOf("{", at); i < CODE_GS.length; i += 1) {
    if (CODE_GS[i] === "{") depth += 1;
    else if (CODE_GS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CODE_GS.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const safeTruncate = new Function(
  `${extract("safeTruncate_")}; return safeTruncate_;`,
)() as (s: unknown, n: number) => string;

/** The value of a `const NAME = "…";` in Code.gs. */
function constant(name: string): string {
  const m = new RegExp(`const ${name} = "([^"]*)";`).exec(CODE_GS);
  if (!m) throw new Error(`no const ${name} in Code.gs — did it move?`);
  return m[1];
}

type ReportStats = { dropped?: number; parked?: number; reason?: string };

type Push = { title: string; body: string };

type Sandbox = {
  report: (stats: ReportStats | null) => void;
  props: Map<string, string>;
  /** Every push ATTEMPTED, delivered or not — `codes` says which. */
  pushes: Push[];
  /**
   * The HTTP status each ntfy POST answers, consumed in order; 200 once empty.
   * `0` makes `UrlFetchApp.fetch` itself throw, which is what a DNS failure or a
   * quota refusal looks like from inside the script.
   */
  codes: number[];
  day: string;
};

/** A `UrlFetchApp` stand-in that records the push and answers a queued status. */
function fakeNtfy(pushes: Push[], codes: number[]) {
  return {
    fetch: (_url: string, opts: { headers: Record<string, string>; payload: string }) => {
      pushes.push({ title: String(opts.headers.Title), body: String(opts.payload) });
      const code = codes.length ? (codes.shift() as number) : 200;
      if (code === 0) throw new Error("DNS error: ntfy.sh");
      return { getResponseCode: () => code };
    },
  };
}

/**
 * `captureBacklogReport_`, its latch AND the real `ntfy_`, EVALUATED out of
 * `Code.gs` with the Google globals stubbed.
 *
 * A source-text assertion cannot see a latch that does not latch, and that is
 * not hypothetical: the previous version of this test counted
 * `alertOncePerDay_(` CALL SITES, which is satisfied by a broken latch — and the
 * latch was broken. Measured on the real thing: 6 pushes over 8 same-day runs of
 * a drop storm, and 9 over 6 runs of the refusal storm the parked pen exists
 * for, because the key carried a running total and both kinds shared one slot.
 * Two of this branch's three test-defect stories are that same shape. The only
 * assertion that can tell a working latch from a broken one is to run it and
 * count the pushes.
 *
 * `opsPush_` USED TO BE A STUB HERE and that hid the third defect: the latch was
 * stamped whether or not the push went out, so an unreachable ntfy lost the day's
 * alert AND the accumulated count. A stub that always succeeds cannot see that.
 * The real `ntfy_`/`opsPush_` run now and the fake is one layer lower, at
 * `UrlFetchApp`, where the failure actually lives.
 */
function sandbox(): Sandbox {
  const props = new Map<string, string>();
  const pushes: Push[] = [];
  const codes: number[] = [];
  const clock = { day: "2026-07-27" };
  const source = [
    `const CAPTURE_DROPPED_PROP = ${JSON.stringify(constant("CAPTURE_DROPPED_PROP"))};`,
    `const CAPTURE_ALERT_DROPPED_PROP = ${JSON.stringify(constant("CAPTURE_ALERT_DROPPED_PROP"))};`,
    `const CAPTURE_ALERT_PARKED_PROP = ${JSON.stringify(constant("CAPTURE_ALERT_PARKED_PROP"))};`,
    `const NTFY_OPS_TOPIC = ${JSON.stringify(constant("NTFY_OPS_TOPIC"))};`,
    extract("safeTruncate_"),
    extract("latin1_"),
    extract("ntfy_"),
    extract("opsPush_"),
    extract("alertOncePerDay_"),
    extract("captureBacklogReport_"),
    "return captureBacklogReport_;",
  ].join("\n");
  const report = new Function(
    "PropertiesService",
    "Utilities",
    "Logger",
    "UrlFetchApp",
    source,
  )(
    {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => props.set(k, v),
        deleteProperty: (k: string) => props.delete(k),
      }),
    },
    { formatDate: () => clock.day },
    { log: () => {} },
    fakeNtfy(pushes, codes),
  ) as (stats: ReportStats | null) => void;
  return {
    report,
    props,
    pushes,
    codes,
    get day() {
      return clock.day;
    },
    set day(d: string) {
      clock.day = d;
    },
  };
}

const NUL = "\u0000";
/**
 * The FIRST astral codepoint, whose high surrogate is 0xD800 exactly.
 *
 * In the corpus for one reason: it is the only value that distinguishes
 * `charCodeAt >= 0xD800` from `> 0xD800`. Nothing about Linear B is realistic
 * recruiter mail — the point is that a mutant this file's header names has to
 * die, and every other astral character leaves the two comparisons identical.
 */
const ASTRAL_LOW = "\u{10000}";
const TARGET = "\u{1F3AF}"; // 🎯 — two UTF-16 units, the shape recruiter mail carries

describe("safeTruncate_ — the script must stop manufacturing lone surrogates", () => {
  it("never leaves half an emoji on the end", () => {
    // 299 plain characters then the emoji: a cut at 300 lands BETWEEN its halves,
    // which is exactly what `snippet: squish_(body).slice(0, 300)` used to do.
    const body = "x".repeat(299) + TARGET + " and more text";
    const cut = safeTruncate(body, 300);
    expect(cut).toHaveLength(299);
    expect(cut.isWellFormed()).toBe(true);
    // The old behaviour, asserted so the test cannot pass by accident.
    const naive = body.slice(0, 300);
    expect(naive.isWellFormed()).toBe(false);
    expect(naive.charCodeAt(299)).toBeGreaterThanOrEqual(0xd800);
  });

  it("keeps a whole emoji when it fits", () => {
    const body = "x".repeat(298) + TARGET + "tail";
    const cut = safeTruncate(body, 300);
    expect(cut).toHaveLength(300);
    expect(cut.endsWith(TARGET)).toBe(true);
    expect(cut.isWellFormed()).toBe(true);
  });

  it("strips NUL, which squish_ cannot — JS \\s does not match U+0000", () => {
    expect(safeTruncate(`a${NUL}b`, 100)).toBe("ab");
    expect(" ".replace(/\s/g, "")).toBe(""); // control: \s does handle a space
    expect(`a${NUL}b`.replace(/\s/g, "")).toBe(`a${NUL}b`); // …and not a NUL
  });

  it("refuses to end on U+D800 itself, not merely above it", () => {
    // The single character that separates `>= 0xD800` from `> 0xD800`. Its own
    // test as well as a corpus entry, because a sweep failing at 30 of 123
    // lengths says "something is wrong" and this says what.
    const body = "x".repeat(9) + ASTRAL_LOW + "tail";
    expect(ASTRAL_LOW.charCodeAt(0)).toBe(0xd800);
    const cut = safeTruncate(body, 10);
    expect(cut).toHaveLength(9);
    expect(cut.isWellFormed()).toBe(true);
    expect(body.slice(0, 10).isWellFormed()).toBe(false); // the naive version
  });

  it("is well-formed for every cut length across an emoji-dense string", () => {
    // The real guarantee, swept rather than sampled: no length may produce an
    // unpaired surrogate. ASTRAL_LOW is in the mix because every OTHER astral
    // character in this corpus has a high surrogate above 0xD800, which left the
    // `>=`-to-`>` mutant alive under a sweep that advertised killing it.
    const dense = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0 ? ASTRAL_LOW : i % 2 ? TARGET : "aé",
    ).join("");
    for (let n = 0; n <= dense.length + 2; n += 1) {
      const cut = safeTruncate(dense, n);
      expect(cut.isWellFormed(), `n=${n} produced an unpaired surrogate`).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(n);
    }
  });

  it("handles the shapes the classifier hands it", () => {
    expect(safeTruncate(null, 10)).toBe("");
    expect(safeTruncate(undefined, 10)).toBe("");
    expect(safeTruncate(0, 10)).toBe("0"); // `String(obj.x || "")` used to do this
    expect(safeTruncate("short", 100)).toBe("short");
  });
});

describe("captureBacklogReport_ — the latch, counted rather than read", () => {
  it("pushes ONCE per kind across a whole day of a drop storm", () => {
    // The measured pre-fix behaviour was 6 pushes over 8 same-day runs, because
    // the key was `"dropped:" + total` and `total` grows exactly when the outage
    // persists. A latch keyed on a value that changes is a change detector.
    const box = sandbox();
    for (let run = 1; run <= 8; run += 1) {
      box.props.set("HQ_CAPTURE_DROPPED", String(run * 5));
      box.report({ dropped: 5 });
    }
    expect(box.pushes).toHaveLength(1);
    expect(box.pushes[0].title).toMatch(/never reached the store/);
  });

  it("does not let the two kinds clear each other's latch", () => {
    // THE case the parked pen exists for: a deploy-order refusal storm fills the
    // pen, its evictions feed the same `dropped` counter, and both branches fire
    // every run. One shared slot meant each overwrote the other — 9 pushes over
    // 6 runs, about six an hour on a 15-minute trigger.
    const box = sandbox();
    for (let run = 1; run <= 6; run += 1) {
      box.props.set("HQ_CAPTURE_DROPPED", String(run * 4));
      box.report({ dropped: 4, parked: run * 8, reason: "unknown field(s): gmail_labels" });
    }
    expect(box.pushes).toHaveLength(2); // exactly one of each kind
    expect(box.pushes.map((p) => p.title).sort()).toEqual([
      expect.stringMatching(/never reached the store/),
      expect.stringMatching(/the store refused/),
    ]);
  });

  it("speaks again the next day, once per kind", () => {
    const box = sandbox();
    box.report({ dropped: 3, parked: 2, reason: "unknown field(s): x" });
    expect(box.pushes).toHaveLength(2);
    box.report({ dropped: 3, parked: 2, reason: "unknown field(s): x" });
    expect(box.pushes).toHaveLength(2); // still the same day
    box.day = "2026-07-28";
    box.report({ dropped: 3, parked: 2, reason: "unknown field(s): x" });
    expect(box.pushes).toHaveLength(4);
  });

  it("carries the counts and the reason in the BODY, never in the key", () => {
    // Where they belong: a person reads the message, the latch reads the day.
    const box = sandbox();
    box.props.set("HQ_CAPTURE_DROPPED", "42");
    box.report({ dropped: 42, parked: 7, reason: "event_type \"maybe\" is not one of …" });
    expect(box.pushes[0].title).toContain("42");
    expect(box.pushes[1].title).toContain("7");
    expect(box.pushes[1].body).toContain("maybe");
    // One slot per kind, holding a bare date.
    expect(box.props.get("HQ_CAPTURE_ALERT_DROPPED")).toBe("2026-07-27");
    expect(box.props.get("HQ_CAPTURE_ALERT_PARKED")).toBe("2026-07-27");
  });

  it("says nothing when there is nothing to say, and survives a broken store", () => {
    const box = sandbox();
    box.report({ dropped: 0, parked: 0 });
    box.report(null);
    expect(box.pushes).toHaveLength(0);
    // m-7, re-asserted through the sandbox rather than by reading the source: a
    // PropertiesService that throws must not escape into `runCapture`.
    const hostile = new Function(
      "PropertiesService",
      "Utilities",
      "Logger",
      "opsPush_",
      [
        `const CAPTURE_DROPPED_PROP = "HQ_CAPTURE_DROPPED";`,
        `const CAPTURE_ALERT_DROPPED_PROP = "HQ_CAPTURE_ALERT_DROPPED";`,
        `const CAPTURE_ALERT_PARKED_PROP = "HQ_CAPTURE_ALERT_PARKED";`,
        extract("safeTruncate_"),
        extract("alertOncePerDay_"),
        extract("captureBacklogReport_"),
        "return captureBacklogReport_;",
      ].join("\n"),
    )(
      {
        getScriptProperties: () => {
          throw new Error("Service invoked too many times");
        },
      },
      { formatDate: () => "2026-07-27" },
      { log: () => {} },
      () => 200,
    ) as (s: ReportStats) => void;
    expect(() => hostile({ dropped: 5 })).not.toThrow();
  });
});

describe("the latch, and the push it is supposed to be latching on", () => {
  /**
   * P-1. `ntfy_` swallowed everything and answered nothing, and
   * `alertOncePerDay_` stamped the day BEFORE calling it. Measured with ntfy
   * unreachable: the day's one alert never left, the latch was set anyway,
   * `captureBacklogReport_` deleted the running counter behind it, and the next
   * day's push understated by exactly the events that had been dropped in
   * between. Three bad outcomes out of one missing return value.
   */
  it("does not latch, and does not throw the count away, when ntfy answers 500", () => {
    const box = sandbox();
    box.codes.push(500);
    box.props.set("HQ_CAPTURE_DROPPED", "12");
    box.report({ dropped: 12 });
    expect(box.pushes).toHaveLength(1); // attempted…
    expect(box.pushes[0].title).toContain("12");
    expect(box.props.get("HQ_CAPTURE_ALERT_DROPPED")).toBeUndefined(); // …not landed
    expect(box.props.get("HQ_CAPTURE_DROPPED")).toBe("12"); // …so the count stays
  });

  it("carries the FULL accumulated count on the run that gets through", () => {
    // The understatement, in the shape it happens: an outage drops more events
    // while ntfy is also down, and the alert that finally lands has to name the
    // whole hole, not the last run's share of it.
    const box = sandbox();
    box.codes.push(500, 500);
    box.props.set("HQ_CAPTURE_DROPPED", "12");
    box.report({ dropped: 12 });
    box.props.set("HQ_CAPTURE_DROPPED", "31");
    box.report({ dropped: 19 });
    expect(box.pushes).toHaveLength(2);

    box.props.set("HQ_CAPTURE_DROPPED", "47"); // ntfy comes back
    box.report({ dropped: 16 });
    expect(box.pushes).toHaveLength(3);
    expect(box.pushes[2].title).toContain("47"); // not 16, and not 12
    expect(box.props.get("HQ_CAPTURE_ALERT_DROPPED")).toBe("2026-07-27");
    expect(box.props.has("HQ_CAPTURE_DROPPED")).toBe(false); // cleared now it landed
  });

  it("then holds for the rest of the day, exactly as before", () => {
    // The cry-wolf property the latch exists for, re-asserted on the far side of
    // the fix: one delivered push per kind per day and nothing after it.
    const box = sandbox();
    box.codes.push(500);
    box.props.set("HQ_CAPTURE_DROPPED", "12");
    box.report({ dropped: 12 }); // lost
    box.props.set("HQ_CAPTURE_DROPPED", "18");
    box.report({ dropped: 6 }); // delivered
    expect(box.pushes).toHaveLength(2);
    for (let run = 0; run < 4; run += 1) {
      box.props.set("HQ_CAPTURE_DROPPED", String(24 + run * 6));
      box.report({ dropped: 6 });
    }
    expect(box.pushes).toHaveLength(2);
  });

  it("treats a fetch that raises like a 500, and never lets it escape", () => {
    // `UrlFetchApp.fetch` throws on DNS, TLS and quota failures — `ntfy_` answers
    // 0 for those, and 0 is not 2xx. The swallow itself is the older contract:
    // a notification must never fail the capture run.
    const box = sandbox();
    box.codes.push(0);
    box.props.set("HQ_CAPTURE_DROPPED", "9");
    expect(() => box.report({ dropped: 9 })).not.toThrow();
    expect(box.pushes).toHaveLength(1);
    expect(box.props.get("HQ_CAPTURE_ALERT_DROPPED")).toBeUndefined();
    expect(box.props.get("HQ_CAPTURE_DROPPED")).toBe("9");
  });

  it("latches each kind on its own delivery", () => {
    // One kind failing must not hold the other's alert back, and must not let it
    // through either: the slots are separate all the way down to the status.
    const box = sandbox();
    box.codes.push(500, 200); // dropped fails, parked lands
    box.report({ dropped: 4, parked: 3, reason: "unknown field(s): gmail_labels" });
    expect(box.pushes).toHaveLength(2);
    expect(box.props.get("HQ_CAPTURE_ALERT_DROPPED")).toBeUndefined();
    expect(box.props.get("HQ_CAPTURE_ALERT_PARKED")).toBe("2026-07-27");

    box.report({ dropped: 4, parked: 3, reason: "unknown field(s): gmail_labels" });
    expect(box.pushes).toHaveLength(3); // only the dropped one speaks again
    expect(box.pushes[2].title).toMatch(/never reached the store/);
    expect(box.props.get("HQ_CAPTURE_ALERT_DROPPED")).toBe("2026-07-27");
  });
});

describe("the two ends agree", () => {
  it("what the script produces is what the endpoint can store, unchanged", () => {
    // The script's output should already be storable, so `storable()` — the
    // endpoint's backstop — is a no-op on it. If this ever fails, one of the two
    // fixes has drifted and the other is silently carrying it.
    const dense = "recruiting update " + TARGET.repeat(40) + NUL + " regards";
    for (const n of [30, 80, 120, 200, 300, 500]) {
      const out = safeTruncate(dense, n);
      expect(storable(out), `n=${n}`).toBe(out);
    }
  });

  it("and the endpoint repairs what any OTHER sender might produce", () => {
    // The division of labour, stated as a test: the script does not manufacture
    // them, the endpoint survives them anyway (an LLM emitting a bare \\ud83c of
    // its own, a future importer, a hand-rolled curl).
    expect(storable(`a${NUL}b`)).toBe("ab");
    expect(storable("a\ud83c").isWellFormed()).toBe(true);
    expect(storable("a\udfaf").isWellFormed()).toBe(true);
    expect(storable(`ok ${TARGET}`)).toBe(`ok ${TARGET}`);
  });
});

type DigestRow = { date: string; body: string; sent_at: string };

type DigestBox = {
  run: () => void;
  props: Map<string, string>;
  mails: { to: string; subject: string; body: string; html: string }[];
  pushes: Push[];
  /** Every `setValue` the run made on the Digest tab: `{row, col, value}`. */
  stamps: { row: number; col: number; value: string }[];
  logs: string[];
};

const STAMP = "2026-07-27 12:00:00Z";

/**
 * `sendDigest` itself, run against a fake Digest tab.
 *
 * Worth the stub surface because the thing under test is a KILL SWITCH: the two
 * ways it can be wrong are "engine mode still mails" (two digests, visible, mild)
 * and "engine mode mails nothing and says nothing", which is a week of no digest
 * with no error anywhere. Only an executed `sendDigest` can tell those apart, and
 * Apps Script has no local runtime — so the Google globals are parameters and the
 * function is the file's own text.
 *
 * `getTabByGid_`/`headerMap_` are stubs rather than the real ones: they need a
 * live Spreadsheet service, and what they do is pinned by the durability contract
 * elsewhere. Everything the switch actually depends on — the property read, the
 * `sent_at` interlock, `MailApp`, the latch, the real `ntfy_` — is the file's.
 */
function digestSandbox(rows: DigestRow[]): DigestBox {
  const props = new Map<string, string>();
  const mails: DigestBox["mails"] = [];
  const pushes: Push[] = [];
  const stamps: DigestBox["stamps"] = [];
  const logs: string[] = [];
  const values: unknown[][] = [
    ["date", "body", "sent_at"],
    ...rows.map((r) => [r.date, r.body, r.sent_at]),
  ];
  const tab = {
    getName: () => "Digest",
    getDataRange: () => ({ getValues: () => values }),
    getRange: (row: number, col: number) => ({
      setValue: (v: string) => stamps.push({ row, col, value: String(v) }),
    }),
  };
  const source = [
    `const DIGEST_SOURCE_PROP = ${JSON.stringify(constant("DIGEST_SOURCE_PROP"))};`,
    `const DIGEST_ALERT_UNSENT_PROP = ${JSON.stringify(constant("DIGEST_ALERT_UNSENT_PROP"))};`,
    `const NTFY_OPS_TOPIC = ${JSON.stringify(constant("NTFY_OPS_TOPIC"))};`,
    extract("latin1_"),
    extract("ntfy_"),
    extract("opsPush_"),
    extract("alertOncePerDay_"),
    extract("cellStr_"),
    extract("escapeHtml_"),
    extract("markdownLiteToHtml_"),
    extract("nowStamp_"),
    extract("digestEmailSource_"),
    extract("digestHandoverWatch_"),
    extract("sendDigest"),
    "return sendDigest;",
  ].join("\n");
  const run = new Function(
    "PropertiesService",
    "Utilities",
    "Logger",
    "UrlFetchApp",
    "MailApp",
    "SpreadsheetApp",
    "assertConfigured_",
    "getTabByGid_",
    "headerMap_",
    "SHEET_ID",
    "DIGEST_GID",
    "DIGEST_HEADERS",
    "OWNER_EMAIL",
    source,
  )(
    {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => props.set(k, v),
        deleteProperty: (k: string) => props.delete(k),
      }),
    },
    // `yyyy-MM-dd` is the latch key and the date fallback; anything else here is
    // `nowStamp_`, which is what lands in `sent_at`.
    { formatDate: (_d: Date, _tz: string, fmt: string) => (fmt === "yyyy-MM-dd" ? "2026-07-27" : STAMP) },
    { log: (m: unknown) => logs.push(String(m)) },
    fakeNtfy(pushes, []),
    {
      sendEmail: (to: string, subject: string, body: string, opts: { htmlBody: string }) =>
        mails.push({ to, subject, body, html: opts.htmlBody }),
    },
    { openById: () => ({}) },
    () => {},
    () => tab,
    () => ({ date: 1, body: 2, sent_at: 3 }),
    "sheet-id",
    7,
    ["date", "body", "sent_at"],
    "owner@example.com",
  ) as () => void;
  return { run, props, mails, pushes, stamps, logs };
}

/** Yesterday's, sent; today's, waiting. The ordinary morning. */
function twoDays(sentToday = ""): DigestRow[] {
  return [
    { date: "2026-07-26", body: "# Yesterday", sent_at: "2026-07-26 12:00:00Z" },
    { date: "2026-07-27", body: "# Today\n- one thing", sent_at: sentToday },
  ];
}

describe("sendDigest — DIGEST_EMAIL_SOURCE, the C3 handover switch", () => {
  it("mails when the property is unset, byte for byte as before", () => {
    const box = digestSandbox(twoDays());
    box.run();
    expect(box.mails).toHaveLength(1);
    expect(box.mails[0].to).toBe("owner@example.com");
    expect(box.mails[0].subject).toContain("2026-07-27");
    expect(box.mails[0].html).toContain("<h2>Today</h2>");
    // The interlock, written by whoever sent: row 3 (header + two rows), col 3.
    expect(box.stamps).toEqual([{ row: 3, col: 3, value: STAMP }]);
    expect(box.pushes).toHaveLength(0);
  });

  it("mails when it says script", () => {
    const box = digestSandbox(twoDays());
    box.props.set("DIGEST_EMAIL_SOURCE", "script");
    box.run();
    expect(box.mails).toHaveLength(1);
    expect(box.stamps).toHaveLength(1);
  });

  it("does NOT mail when it says engine", () => {
    const box = digestSandbox(twoDays());
    box.props.set("DIGEST_EMAIL_SOURCE", "engine");
    box.run();
    expect(box.mails).toHaveLength(0);
    expect(box.stamps).toHaveLength(0); // the engine stamps, not this
  });

  it("pushes once when the engine did not send, and says how to roll back", () => {
    // The failure the switch creates and this watchdog closes: the property is
    // flipped, the engine's own gate is not, and there is no digest and no error.
    const box = digestSandbox(twoDays());
    box.props.set("DIGEST_EMAIL_SOURCE", "engine");
    box.run();
    expect(box.pushes).toHaveLength(1);
    expect(box.pushes[0].title).toMatch(/engine did not send/);
    expect(box.pushes[0].body).toContain("DIGEST_EMAIL_SOURCE");
    expect(box.pushes[0].body).toContain('"script"'); // the rollback, in the push
    // Latched per day, on its own slot, like every other alert in the file.
    expect(box.props.get("HQ_DIGEST_ALERT_UNSENT")).toBe("2026-07-27");
    box.run();
    box.run();
    expect(box.pushes).toHaveLength(1);
  });

  it("is silent when the engine DID send — the stamp is the whole interlock", () => {
    const box = digestSandbox(twoDays("2026-07-27 11:40:02Z"));
    box.props.set("DIGEST_EMAIL_SOURCE", "engine");
    box.run();
    expect(box.mails).toHaveLength(0);
    expect(box.pushes).toHaveLength(0);
    expect(box.logs.join("\n")).toMatch(/engine sent 2026-07-27/);
  });

  it("mails on an unrecognised value, because the safe direction is sending", () => {
    for (const bad of ["enginee", "true", "1", "lambda", "off"]) {
      const box = digestSandbox(twoDays());
      box.props.set("DIGEST_EMAIL_SOURCE", bad);
      box.run();
      expect(box.mails, bad).toHaveLength(1);
      expect(box.logs.join("\n"), bad).toMatch(/is not script\|engine/);
    }
  });

  it("takes the value with stray case and space, which a pasted property has", () => {
    const box = digestSandbox(twoDays());
    box.props.set("DIGEST_EMAIL_SOURCE", " Engine ");
    box.run();
    expect(box.mails).toHaveLength(0);
    expect(box.pushes).toHaveLength(1);
  });

  it("still refuses to mail an older unsent row when the newest is sent", () => {
    // Unchanged script-mode behaviour, re-asserted because the switch reads
    // `sent_at` one line above the `break` that enforces it.
    const box = digestSandbox([
      { date: "2026-07-25", body: "# Stale news", sent_at: "" },
      { date: "2026-07-27", body: "# Today", sent_at: STAMP },
    ]);
    box.run();
    expect(box.mails).toHaveLength(0);
    expect(box.logs.join("\n")).toContain("nothing to send");
  });
});
