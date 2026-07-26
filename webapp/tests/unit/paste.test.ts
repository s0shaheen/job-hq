import { describe, expect, it } from "vitest";
import {
  MAX_NAME_LENGTH,
  MAX_PASTE_NAMES,
  parsePastedNames,
} from "@/app/(app)/companies/paste";

/**
 * The pasted-list parser.
 *
 * It is guesswork by nature — a CSV column, a comma-joined sentence and a bulleted
 * list all look different — so the cases below are the shapes people actually paste,
 * and each one is here because getting it wrong produces a *company* that does not
 * exist. That is worse than dropping a line: a bogus name sits in the review pile
 * forever, and a resolver will never ground it.
 *
 * The list-marker case was found by LOOKING at the add form's preview, not by any
 * assertion: `- 1. McDonald's` came through as `1. McDonald's` because the marker
 * strip ran once and the two markers combine. That is now a test.
 */

describe("parsePastedNames", () => {
  it("splits one name per line", () => {
    expect(parsePastedNames("Northern Trust\nCboe Global Markets\nGrainger")).toEqual([
      "Northern Trust",
      "Cboe Global Markets",
      "Grainger",
    ]);
  });

  it("splits a comma-joined sentence", () => {
    // Someone typing a list inline means a list, not one 40-character company.
    expect(parsePastedNames("Aon, Exelon, Grainger")).toEqual(["Aon", "Exelon", "Grainger"]);
  });

  it("handles Windows line endings and tabs", () => {
    expect(parsePastedNames("Aon\r\nExelon\tGrainger")).toEqual(["Aon", "Exelon", "Grainger"]);
  });

  it("unwraps CSV quotes", () => {
    expect(parsePastedNames('"Kraft Heinz"\n\'Old Republic\'')).toEqual([
      "Kraft Heinz",
      "Old Republic",
    ]);
  });

  it("strips COMBINED list markers, not just the first", () => {
    // The bug the preview surfaced. A line out of a formatted document arrives as
    // "- 1. McDonald's", and one pass leaves "1. McDonald's" as the company name.
    expect(parsePastedNames("- 1. McDonald's")).toEqual(["McDonald's"]);
    expect(parsePastedNames("• Aon\n* Exelon\n1. Grainger\n2) Deere\n– Abbott")).toEqual([
      "Aon",
      "Exelon",
      "Grainger",
      "Deere",
      "Abbott",
    ]);
  });

  it("keeps a number that is part of the name", () => {
    // "3M" and "1-800-Flowers" are companies. The marker pattern requires the digits
    // to be followed by "." or ")", so a bare leading number survives.
    expect(parsePastedNames("3M\n1-800-Flowers")).toEqual(["3M", "1-800-Flowers"]);
  });

  it("drops blank and whitespace-only lines without failing", () => {
    // A trailing newline is the normal end of a paste, not an error.
    expect(parsePastedNames("Aon\n\n   \n\nExelon\n")).toEqual(["Aon", "Exelon"]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    // Matching app_propose_companies, so the count previewed is the count added.
    expect(parsePastedNames("Aon\naon\nAON\nExelon")).toEqual(["Aon", "Exelon"]);
  });

  it("drops a line past the length bound rather than truncating it", () => {
    // Truncating would INVENT a company name — the one outcome worse than losing
    // the line, because the invented row is indistinguishable from a real one.
    const long = "x".repeat(MAX_NAME_LENGTH + 1);
    expect(parsePastedNames(`Aon\n${long}\nExelon`)).toEqual(["Aon", "Exelon"]);
    expect(parsePastedNames("y".repeat(MAX_NAME_LENGTH))).toHaveLength(1);
  });

  it("returns nothing for an empty or punctuation-only paste", () => {
    expect(parsePastedNames("")).toEqual([]);
    expect(parsePastedNames("   \n\t\n,,,")).toEqual([]);
    // A line of nothing but markers must collapse to nothing — not leave the last
    // one standing as a company. The first version stripped markers in a bounded
    // LOOP and this line ran past the bound, so "3." came through as a name.
    expect(parsePastedNames("- - - 1. 2. 3.")).toEqual([]);
  });

  it("preserves a name's internal punctuation and casing", () => {
    expect(parsePastedNames("Baker Tilly US, LLP".replace(",", ""))).toEqual([
      "Baker Tilly US LLP",
    ]);
    expect(parsePastedNames("S&P Global\nJ.P. Morgan")).toEqual(["S&P Global", "J.P. Morgan"]);
  });

  it("splits a name containing a comma — the deliberate, recoverable trade", () => {
    // Documented in paste.ts: this direction is chosen because a split name is
    // visible in the preview and fixable in one edit, while a comma-joined paste
    // collapsed into one row would resolve to nothing, forever, with no visible cause.
    expect(parsePastedNames("Guggenheim Partners, LLC")).toEqual([
      "Guggenheim Partners",
      "LLC",
    ]);
  });

  it("parses a paste at the bound without dropping any of it", () => {
    const names = Array.from({ length: MAX_PASTE_NAMES }, (_, i) => `Company ${i}`);
    expect(parsePastedNames(names.join("\n"))).toHaveLength(MAX_PASTE_NAMES);
  });
});
