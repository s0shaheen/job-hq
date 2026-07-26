import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  groupRank,
  isCanonicalStatus,
  isReopenable,
  OTHER_GROUP,
  selectableStatuses,
  STATUS_ORDER,
  STATUS_RESOLVED,
  STATUS_TERMINAL,
  STATUSES,
  statusGroup,
  statusRank,
  statusTone,
} from "@/lib/status";

/**
 * The status vocabulary, compared against the engine that writes it.
 *
 * `core/schema.py` is the authority: the sweep, the joiner and the sheet all
 * read those lists, and a webapp copy that drifts puts a real row in the wrong
 * group or sorts it into a stage it was never in. A comment saying "keep in
 * step" is not a mechanism, so this parses the Python.
 *
 * Matrix row 55 in docs/plans/README.md ("status list drifts from
 * core/schema.py"), and the reason `lib/status.ts` exists at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SCHEMA_PY = readFileSync(path.join(REPO, "core", "schema.py"), "utf8");

/** `NAME = ["a", "b"]` out of the Python, as a string array. */
function pyList(name: string): string[] {
  const m = new RegExp(`^${name}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(SCHEMA_PY);
  if (!m) throw new Error(`${name} not found in core/schema.py`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

describe("parity with core/schema.py", () => {
  it("finds the lists at all — otherwise every check below is vacuous", () => {
    expect(pyList("STATUS_ORDER").length).toBeGreaterThan(0);
    expect(pyList("STATUS_TERMINAL").length).toBeGreaterThan(0);
    expect(pyList("STATUS_RESOLVED").length).toBeGreaterThan(0);
  });

  it("STATUS_ORDER matches, in order", () => {
    expect([...STATUS_ORDER]).toEqual(pyList("STATUS_ORDER"));
  });

  it("STATUS_TERMINAL matches", () => {
    expect([...STATUS_TERMINAL]).toEqual(pyList("STATUS_TERMINAL"));
  });

  it("STATUS_RESOLVED matches", () => {
    expect([...STATUS_RESOLVED]).toEqual(pyList("STATUS_RESOLVED"));
  });

  it("ranks every canonical status exactly as Python does", () => {
    // The Python's tiering, transcribed from core/schema.py:status_rank. If the
    // TS port drifts, one of these disagrees — and comparing the whole ordering
    // rather than a handful of pairs is what makes an off-by-one tier visible.
    const order = pyList("STATUS_ORDER");
    const terminal = pyList("STATUS_TERMINAL");
    const resolved = pyList("STATUS_RESOLVED");
    const pyRank = (s: string): number => {
      if (!s.trim()) return -1;
      const i = order.indexOf(s);
      if (i !== -1) return i;
      if (terminal.includes(s)) return order.length + 1;
      if (resolved.includes(s)) return order.length + 2;
      return order.length + 3;
    };
    for (const s of [...order, ...terminal, ...resolved, "", "Aplied", "my own stage"]) {
      expect([s, statusRank(s)]).toEqual([s, pyRank(s)]);
    }
  });
});

describe("statusRank", () => {
  it("puts an accepted offer above every terminal state", () => {
    expect(statusRank("Offer-Accepted")).toBeGreaterThan(statusRank("Rejected"));
    expect(statusRank("Offer-Declined")).toBeGreaterThan(statusRank("Closed"));
  });

  it("puts an invented status above everything", () => {
    for (const s of STATUSES) {
      expect(statusRank("waiting on referral")).toBeGreaterThan(statusRank(s));
    }
  });

  it("treats blank as before the beginning, not as Inbox", () => {
    expect(statusRank("")).toBeLessThan(statusRank("Inbox"));
    expect(statusRank("   ")).toBe(-1);
  });

  it("trims, because a sheet cell carries whatever a human pasted", () => {
    expect(statusRank(" Applied ")).toBe(statusRank("Applied"));
  });
});

describe("grouping", () => {
  it("groups a canonical status under itself", () => {
    for (const s of STATUSES) expect(statusGroup(s)).toBe(s);
  });

  it("collapses invented statuses into one Other group", () => {
    expect(statusGroup("waiting on referral")).toBe(OTHER_GROUP);
    expect(statusGroup("Aplied")).toBe(OTHER_GROUP);
    expect(statusGroup("")).toBe(OTHER_GROUP);
  });

  it("orders groups by the ladder and puts Other last", () => {
    const groups = [...STATUSES, OTHER_GROUP];
    const ranked = [...groups].sort((a, b) => groupRank(a) - groupRank(b));
    expect(ranked).toEqual(groups);
    expect(groupRank(OTHER_GROUP)).toBeGreaterThan(groupRank("Closed"));
  });
});

describe("selectableStatuses", () => {
  it("hides the resolved pair everywhere except at Offer", () => {
    for (const s of ["Inbox", "Applied", "Final", "Rejected", "Withdrawn"]) {
      expect(selectableStatuses(s)).not.toContain("Offer-Accepted");
    }
    expect(selectableStatuses("Offer")).toContain("Offer-Accepted");
    expect(selectableStatuses("Offer")).toContain("Offer-Declined");
  });

  it("keeps the resolved pair visible once a row is already resolved", () => {
    // Otherwise the Select renders a trigger whose current value is not in its
    // own list, and Radix shows an empty box over a row that plainly has a status.
    expect(selectableStatuses("Offer-Accepted")).toContain("Offer-Accepted");
  });

  it("offers an invented status back to itself", () => {
    expect(selectableStatuses("waiting on referral")).toContain("waiting on referral");
  });

  it("never offers a duplicate", () => {
    for (const s of [...STATUSES, "custom"]) {
      const list = selectableStatuses(s);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe("isReopenable", () => {
  it("covers the three terminal states", () => {
    for (const s of STATUS_TERMINAL) expect(isReopenable(s)).toBe(true);
  });

  it("does not offer a rewind on a resolved search", () => {
    // Reopening an accepted offer is a different decision, not a correction.
    for (const s of STATUS_RESOLVED) expect(isReopenable(s)).toBe(false);
  });

  it("does not offer it mid-pipeline", () => {
    for (const s of STATUS_ORDER) expect(isReopenable(s)).toBe(false);
  });
});

describe("isCanonicalStatus / statusTone", () => {
  it("recognises every canonical status and nothing else", () => {
    for (const s of STATUSES) expect(isCanonicalStatus(s)).toBe(true);
    expect(isCanonicalStatus("Aplied")).toBe(false);
    expect(isCanonicalStatus("")).toBe(false);
  });

  it("gives an accepted offer the same positive tone as the offer itself", () => {
    expect(statusTone("Offer-Accepted")).toBe("ok");
    expect(statusTone("Offer")).toBe("ok");
  });

  it("gives every status a defined tone, including invented ones", () => {
    for (const s of [...STATUSES, "something else", ""]) {
      expect(["ok", "accent", "info", "warn", "neutral"]).toContain(statusTone(s));
    }
  });
});
