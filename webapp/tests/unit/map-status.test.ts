// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// map-status shares `Cell`/`cellText` with the server-only reader; see the note
// in map-columns.test.ts.
vi.mock("server-only", () => ({}));

import {
  collectStatusValues,
  importedStatusNote,
  normalizeStatus,
  STATUS_ALIASES,
  suggestStatusMap,
  UNKNOWN_STATUS_FALLBACK,
} from "@/lib/import/map-status";
import { isCanonicalStatus, STATUS_RESOLVED, STATUSES } from "@/lib/status";

/**
 * The invariant under test: **no spreadsheet cell may mint a status.**
 *
 * `core/schema.py:150` puts a human-invented status above everything — above
 * Offer, above Rejected — and no bot may touch a row carrying one. That is right
 * for a word a person typed on purpose. Arriving 300 times from a column called
 * "Stage" it freezes 300 rows against the engine that is meant to be tracking
 * them, and nothing in the import says so (matrix row 43).
 *
 * So: closed vocabulary, unknown values land in Inbox, and the file's own word
 * is preserved in the notes instead of thrown away.
 */

describe("the alias table", () => {
  it("only ever produces statuses lib/status.ts defines", () => {
    // The structural claim this module makes to the rest of the system.
    for (const [word, status] of Object.entries(STATUS_ALIASES)) {
      expect(isCanonicalStatus(status), `${word} -> ${status}`).toBe(true);
    }
  });

  it("registers every canonical status as an alias of itself", () => {
    // Without this, export -> edit -> re-import demotes Final and Queued to
    // Inbox on the way back, which is the loudest way to lose trust in import.
    for (const status of STATUSES) {
      expect(STATUS_ALIASES[normalizeStatus(status)]).toBe(status);
    }
  });

  it("keeps every key in normalized form, so it can be hit", () => {
    for (const key of Object.keys(STATUS_ALIASES)) {
      expect(normalizeStatus(key)).toBe(key);
    }
  });
});

describe("the simplify.py vocabulary", () => {
  it("agrees with tracker/simplify.py about what their words mean", () => {
    const m = suggestStatusMap([
      "saved",
      "applied",
      "screen",
      "interview",
      "offer",
      "rejected",
      "withdrawn",
      "ghosted",
      "oa",
      "assessment",
      "take home",
    ]);
    expect(m["saved"].status).toBe("Inbox");
    expect(m["applied"].status).toBe("Applied");
    expect(m["screen"].status).toBe("Screen");
    expect(m["interview"].status).toBe("Interview");
    expect(m["offer"].status).toBe("Offer");
    expect(m["rejected"].status).toBe("Rejected");
    expect(m["withdrawn"].status).toBe("Withdrawn");
    expect(m["ghosted"].status).toBe("Closed");
    expect(m["oa"].status).toBe("OA");
    expect(m["assessment"].status).toBe("OA");
    expect(m["take home"].status).toBe("OA");
    for (const entry of Object.values(m)) {
      expect(entry.source).toBe("alias");
      expect(entry.note).toBeNull();
    }
  });

  it("ignores case, spacing and punctuation", () => {
    const m = suggestStatusMap(["  APPLIED  ", "Applied", "applied", "Take-Home", "phone_screen"]);
    expect(m["  APPLIED  "].status).toBe("Applied");
    expect(m["Applied"].status).toBe("Applied");
    expect(m["applied"].status).toBe("Applied");
    expect(m["Take-Home"].status).toBe("OA");
    expect(m["phone_screen"].status).toBe("Screen");
  });

  it("refuses to map a foreign word onto a human-only status", () => {
    // Offer-Accepted / Offer-Declined are human-only in the engine and in the
    // database. A cell is not a human deciding — so "accepted" falls back rather
    // than resolving an offer nobody accepted.
    const m = suggestStatusMap(["accepted", "declined"]);
    expect(m["accepted"].status).toBe(UNKNOWN_STATUS_FALLBACK);
    expect(m["declined"].status).toBe(UNKNOWN_STATUS_FALLBACK);
    for (const resolved of STATUS_RESOLVED) {
      // They still round-trip under their own name; nothing else reaches them.
      expect(STATUS_ALIASES[normalizeStatus(resolved)]).toBe(resolved);
    }
  });

  it("leaves genuinely two-sided words unmapped rather than flipping a coin", () => {
    for (const word of ["in progress", "pending", "waiting", "open", "n/a"]) {
      expect(suggestStatusMap([word])[word].source).toBe("fallback");
    }
  });
});

describe("an unrecognised value", () => {
  const original = "Awaiting recruiter";
  const m = suggestStatusMap([original, "Ghosted by recruiter", "Round 2 of 4"]);

  it("lands in Inbox rather than becoming a status of its own", () => {
    expect(m[original].status).toBe("Inbox");
    expect(m[original].source).toBe("fallback");
    expect(m["Ghosted by recruiter"].status).toBe("Inbox");
    expect(m["Round 2 of 4"].status).toBe("Inbox");
  });

  it("preserves the file's own wording, verbatim, for the notes", () => {
    // Recoverable information. A row silently retitled Inbox is not.
    expect(m[original].note).toBe('Imported status: "Awaiting recruiter"');
    expect(importedStatusNote("Round 2 of 4")).toBe('Imported status: "Round 2 of 4"');
  });

  it("quotes the raw spelling, not a normalized one", () => {
    const messy = suggestStatusMap(["  Awaiting  Recruiter  "]);
    expect(messy["  Awaiting  Recruiter  "].note).toBe(
      'Imported status: "  Awaiting  Recruiter  "',
    );
  });

  it("cannot return anything outside the vocabulary, whatever it is handed", () => {
    const wild = suggestStatusMap([
      "Aplied",
      "STATUS",
      "42",
      "<script>",
      "Offer-Accepted-ish",
      "",
      "   ",
      "-",
    ]);
    for (const [value, entry] of Object.entries(wild)) {
      expect(isCanonicalStatus(entry.status), `${value} -> ${entry.status}`).toBe(true);
    }
  });

  it("attaches a note to every fallback and to no alias hit", () => {
    // The pairing is the mechanism: a fallback without a note loses the word, an
    // alias hit with one duplicates it into the notes of every imported row.
    for (const entry of Object.values(suggestStatusMap(["applied", "Awaiting recruiter"]))) {
      expect(entry.note === null).toBe(entry.source === "alias");
    }
  });
});

describe("collectStatusValues", () => {
  const rows = [
    ["Acme", "Applied"],
    ["Globex", "applied "],
    ["Initech", "Screen"],
    ["Umbrella", "APPLIED"],
    ["Soylent", ""],
    ["Tyrell", "   "],
    ["Cyberdyne", "-"],
    ["Weyland", "Awaiting recruiter"],
  ];

  it("folds spellings of one word into one decision, with a true count", () => {
    const values = collectStatusValues(rows, 1);
    const applied = values.find((v) => normalizeStatus(v.value) === "applied");
    // Three rows, one decision for the user. Split into three rows in the UI the
    // counts lie about which value is worth thinking about.
    expect(applied?.count).toBe(3);
    // Edge whitespace is trimmed on the way in ("applied " is not a fourth
    // spelling of anything); casing is not, because the notes quote it.
    expect(applied?.variants).toEqual(["Applied", "applied", "APPLIED"]);
  });

  it("keeps the first spelling seen as the one to show", () => {
    expect(collectStatusValues(rows, 1)[0].value).toBe("Applied");
  });

  it("does not offer a blank or a placeholder as something to map", () => {
    // A row with no status is a row whose status the file never stated. Listing
    // "" invites mapping it, and a dash is somebody's way of writing "none".
    const values = collectStatusValues(rows, 1);
    expect(values.map((v) => v.value)).toEqual(["Applied", "Screen", "Awaiting recruiter"]);
  });

  it("sorts by count so the biggest decision is first", () => {
    expect(collectStatusValues(rows, 1).map((v) => v.count)).toEqual([3, 1, 1]);
  });

  it("survives a ragged column without inventing values", () => {
    expect(collectStatusValues([["Acme"], [], ["Globex", "Applied"]], 1)).toEqual([
      { value: "Applied", count: 1, variants: ["Applied"] },
    ]);
  });

  it("feeds suggestStatusMap directly", () => {
    const values = collectStatusValues(rows, 1);
    const m = suggestStatusMap(values);
    expect(m["Applied"].status).toBe("Applied");
    expect(m["Awaiting recruiter"]).toEqual({
      status: "Inbox",
      source: "fallback",
      note: 'Imported status: "Awaiting recruiter"',
    });
  });
});
