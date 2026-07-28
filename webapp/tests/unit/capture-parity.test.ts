// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  MAX_EVENTS,
  parseEvent,
  type CaptureRow,
} from "@/lib/capture/schema";
import { EVENT_TYPES_SQL, FAKE_MAX_EVENTS, checkRow } from "./capture-fake";

/**
 * The fake store, held to what Postgres actually does.
 *
 * `capture-route.test.ts` drives the handler against `FakeCaptureStore`, so every
 * claim that file makes about batch semantics is only as true as the fake. Three
 * times in this repo a fake has been kinder than the store and every test stayed
 * green while production misbehaved (matrix rows 212, 238, 266). This file is the
 * comparison: 0018's own text on one side, the fake and the route's validator on
 * the other.
 *
 * THE ASSERTION THAT MATTERS MOST is the last one — everything `parseEvent`
 * accepts, `checkRow` accepts. If the route's validator were ever looser than the
 * store's CHECKs, a row would pass validation, reach SQL, and come back as a
 * `rejected` outcome carrying a raw constraint name instead of a sentence. That
 * is not a crash; it is a class of row that silently never lands, reported in
 * language nobody reads.
 *
 * MUTATION TARGETS:
 *   * delete a type from `EVENT_TYPES` in schema.ts  -> the vocabulary test
 *   * raise `MAX_EVENTS` above the SQL cap           -> the cap-ordering test
 *   * relax `checkRow`'s confidence bound            -> the CHECK-coverage test
 *   * relax `parseEvent`'s confidence bound          -> the subset test
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SQL = readFileSync(path.join(REPO, "db", "migrations", "0018_capture.sql"), "utf8");

/** The `array[...]` literal inside a `returns text[]` function, as strings. */
function sqlArray(fn: string): string[] {
  const at = SQL.indexOf(`function public.${fn}(`);
  if (at === -1) throw new Error(`no ${fn}() in 0018 — did it move?`);
  const body = SQL.slice(at, SQL.indexOf("$$;", at));
  const arr = /array\[([^\]]+)\]/i.exec(body);
  if (!arr) throw new Error(`no array literal in ${fn}()`);
  return [...arr[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("the event-type vocabulary", () => {
  it("is the same list in the migration, the route's parser, and the fake", () => {
    const inSql = sqlArray("hq_email_event_types");
    // Order too, not just membership: the endpoint's refusal message lists them,
    // and a list that reorders itself between languages is one somebody will
    // eventually diff by eye and call identical.
    expect([...EVENT_TYPES]).toEqual(inSql);
    expect(EVENT_TYPES_SQL).toEqual(inSql);
  });
});

describe("the caps", () => {
  it("the fake's batch cap is the migration's", () => {
    const m = /c_max_events\s+constant\s+integer\s*:=\s*(\d+)/.exec(SQL);
    expect(m, "no c_max_events in 0018").toBeTruthy();
    expect(FAKE_MAX_EVENTS).toBe(Number(m![1]));
  });

  it("the endpoint's cap is at or below the store's", () => {
    // If the route accepted more than the store, a batch would pass the envelope
    // check and then RAISE inside SQL — one 500 for a batch that was merely
    // large, and the retry queue grinding on it forever.
    expect(MAX_EVENTS).toBeLessThanOrEqual(FAKE_MAX_EVENTS);
  });
});

describe("the CHECK constraints", () => {
  it("the fake can produce every refusal 0018 declares", () => {
    const declared = [...SQL.matchAll(/constraint (email_events_\w+)\s*\n?\s*check/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual([
      "email_events_confidence_is_a_probability",
      "email_events_event_id_present",
      "email_events_type_is_known",
    ]);
    // Each one, reached. A fake that lists the constraint names in a comment and
    // enforces two of them is the shape this file exists to catch.
    const base = row({});
    const reached = new Set(
      [
        checkRow(row({ event_id: "   " })),
        checkRow(row({ event_type: "maybe" })),
        checkRow(row({ confidence: 9 })),
      ].map((r) => /"(email_events_\w+)"/.exec(r ?? "")?.[1] ?? ""),
    );
    expect([...reached].sort()).toEqual(declared.sort());
    expect(checkRow(base)).toBeNull(); // the positive control
  });

  it("refuses a stamp the column could not hold", () => {
    expect(checkRow(row({ received_at: "not a stamp" }))).toMatch(/timestamp with time zone/);
    expect(checkRow(row({ processed_at: "2026-99-99T00:00:00Z" }))).toMatch(
      /timestamp with time zone/,
    );
  });
});

describe("the route's validator is STRICTER than the store, never looser", () => {
  it("accepts nothing the store would reject", () => {
    // A corpus of everything a real sender produces plus every edge the parser
    // deliberately tolerates. Each accepted row is then offered to the store's
    // rules; a single rejection here means a row that validates, travels, and
    // comes back as an unreadable constraint name.
    const corpus: Record<string, unknown>[] = [
      wire(),
      ...EVENT_TYPES.map((t) => wire({ event_type: t })),
      wire({ confidence: 0 }),
      wire({ confidence: 1 }),
      wire({ confidence: "0.5" }),
      wire({ confidence: undefined }),
      wire({ processed_at: "" }),
      wire({ processed_at: "2026-07-27 14:02:19Z" }),
      wire({ received_at: "2028-02-29T00:00:00Z" }), // a real leap day
      wire({ received_at: "2026-07-27T14:02:11.500Z" }),
      wire({ event_id: "  <padded@x>  " }), // trimmed by the parser
      wire({ event_id: "<a@x>", account: "", company: "", title: "", ats: "" }),
      wire({ subject: "x".repeat(2000) }),
      wire({ subject: "unicode — 日本語 — emoji 🎯" }),
      // The C-1 shapes. The corpus carried only WELL-FORMED unicode, which is
      // why the class that actually broke the store was not in it: a NUL and an
      // unpaired surrogate are refused at the jsonb cast, above the per-row
      // block, so `checkRow` seeing them as fine is the whole point — the route
      // must have repaired them by the time they get here.
      wire({ subject: "cut through an emoji \ud83c" }),
      wire({ snippet: "trailing low half \udfaf" }),
      wire({ company: "NUL inside \u0000 here" }),
      wire({ evidence: "\u0000\ud83c both" }),
      wire({ event_id: "<a\u200bb@x>" }), // a zero-width INSIDE a key is legal
      wire({ job_url: "" }),
      wire({ thread_link: "" }),
      wire({ event_type: undefined }), // defaults to 'other'
    ];
    let accepted = 0;
    for (const raw of corpus) {
      const parsed = parseEvent(raw);
      if (!parsed.ok) continue; // the parser refusing is always allowed
      accepted += 1;
      expect(checkRow(parsed.row), `store rejects ${JSON.stringify(raw)}`).toBeNull();
      // …and the row must SURVIVE THE WIRE, which `checkRow` cannot see: a NUL
      // or an unpaired surrogate never reaches a CHECK constraint at all,
      // because `jsonb` refuses the whole payload one layer above it.
      const payload = JSON.stringify(parsed.row);
      expect(payload.isWellFormed(), `not castable: ${JSON.stringify(raw)}`).toBe(true);
      expect(payload, `carries a NUL: ${JSON.stringify(raw)}`).not.toContain("\\u0000");
    }
    // Guards the loop from passing vacuously if `parseEvent` started refusing
    // everything — the shape matrix row 207 was written about.
    expect(accepted).toBe(corpus.length);
  });
});

describe("the payload keys are the function's parameter names", () => {
  it("every column hq_capture_email_events inserts is a key of CaptureRow", () => {
    // The store's function reads `v_event ->> 'from_addr'`, so a rename on the
    // TypeScript side is not a type error anywhere — it is a column that
    // silently goes blank. Same class as the select-list pin, one layer over.
    const at = SQL.indexOf("insert into public.email_events (");
    const cols = SQL.slice(at + "insert into public.email_events (".length, SQL.indexOf(")", at))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sent = Object.keys(row({}));
    // user_id comes from the function's own argument, not from the payload.
    expect(cols.filter((c) => c !== "user_id").sort()).toEqual(sent.sort());
  });

  it("every payload key is read out of the jsonb by that exact name", () => {
    for (const key of Object.keys(row({}))) {
      expect(SQL, `hq_capture_email_events never reads '${key}'`).toContain(`'${key}'`);
    }
  });
});

// ---------------------------------------------------------------- helpers

function row(over: Partial<CaptureRow>): CaptureRow {
  return {
    event_id: "<a@x>",
    account: "main",
    received_at: "2026-07-27T14:02:11.000Z",
    from_addr: "a@b.c",
    subject: "s",
    snippet: "n",
    event_type: "received",
    company: "Ramp",
    title: "PM",
    ats: "greenhouse",
    job_url: "https://x",
    confidence: 0.9,
    evidence: "e",
    thread_link: "https://t",
    processed_at: "2026-07-27T14:02:19.000Z",
    ...over,
  };
}

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event_id: "<a@x>",
    account: "main",
    received_at: "2026-07-27T14:02:11Z",
    from: "a@b.c",
    subject: "s",
    snippet: "n",
    event_type: "received",
    company: "Ramp",
    title: "PM",
    ats: "greenhouse",
    job_url: "https://x",
    confidence: 0.9,
    evidence: "e",
    thread_link: "https://t",
    processed_at: "2026-07-27 14:02:19Z",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}
