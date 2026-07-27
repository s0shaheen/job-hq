// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// `lib/import/read.ts` starts with `import "server-only"`, whose whole job is to
// throw when it is loaded outside a React Server Component. Replacing it is what
// lets the parser be driven from here; nothing else is stubbed. (`connections.ts`
// itself imports nothing server-only — that is the point of it being pure.)
vi.mock("server-only", () => ({}));

import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { companyNameKey } from "@/lib/data/view-models";
import { readDelimited, sniffHeaderRow } from "@/lib/import/read";
import * as mapColumns from "@/lib/import/map-columns";
import { diceCoefficient, FUZZY_FLOOR, normalizeHeader } from "@/lib/import/suggest";
import {
  applyConnectionMapping,
  CONNECTION_ALIASES,
  CONNECTION_FIELDS,
  CONNECTION_SOURCE_TAGS,
  joinName,
  previewConnections,
  readConnectedOn,
  suggestConnectionMapping,
  toImportRows,
  unmappedConnectionHeaders,
  type ConnectionMapping,
} from "@/lib/referral/connections";

/**
 * Reading LinkedIn's own `Connections.csv`, end to end and in one file.
 *
 * ONE FILE ON PURPOSE (matrix row 176). Parsing a realistic export is the
 * expensive thing this suite does, and the last time that work was spread across
 * several specs the contention took an unrelated file down instead — a budget
 * that only holds when nobody else is working is a statement about the machine.
 * Every fixture-parsing test for this feature lives here.
 *
 * The failure this file exists to make impossible is the first thing that
 * happens to a naive reader: **LinkedIn's export does not start with its header
 * row.** It opens with a literal `Notes:` line and a paragraph of prose about
 * missing email addresses, then a blank line, and only then the columns. A
 * reader that takes row 1 maps `Notes:` as a one-column header and files 3,000
 * people under it — and the import "succeeds".
 */

// ------------------------------------------------------------ the real export

/** LinkedIn's own preamble text, near enough to the byte. */
const NOTES_PARAGRAPH =
  '"When exporting your connection data, you may notice that some of the email ' +
  "addresses are missing. You will only see email addresses for connections who " +
  "have allowed their connections to see or download their email address using " +
  'this setting https://www.linkedin.com/psettings/privacy/email."';

const STOCK_HEADERS = "First Name,Last Name,URL,Email Address,Company,Position,Connected On";

/**
 * Seven data rows carrying one of everything the preview has to count:
 * a duplicate profile URL, a duplicate (name, company) with no URL between them,
 * an unreadable date, a nameless line, a company in the universe and one that is
 * not.
 */
const DATA_ROWS = [
  "Ada,Okonkwo,https://www.linkedin.com/in/ada,ada@example.com,Ramp,Product Manager,21 Mar 2023",
  // The same person again, as a monthly re-export gives them: same URL, newer title.
  "Ada,Okonkwo,https://www.linkedin.com/in/ada,ada@example.com,Ramp,Head of Bill Pay,Mar 21 2023",
  // No URL — LinkedIn withholds it for connections who restricted it.
  "Bo,Lindqvist,,bo@example.com,Ramp,Engineering Manager,2023-11-02",
  // …and the same URL-less person twice, with a date nothing can read.
  "Bo,Lindqvist,,,Ramp,Senior Engineering Manager,03/04/2026",
  // The company spelled with U+00A0, which is what pasting out of a web page
  // leaves. The universe spells it with a plain space, and only `company_name_key`
  // calls them one employer — so this row is what gives `matchedCompanies` teeth.
  "Chandra,Rao,https://www.linkedin.com/in/chandra,,Fifth\u00a0Third Bank,VP Digital Product,2022-06-30",
  // A line with no name at all. One malformed line must not refuse the others.
  ",,,nobody@example.com,Ghost Holdings,Analyst,",
  "Eleni,P,https://www.linkedin.com/in/eleni,,Anthropic,Member of Technical Staff,2025-01-19",
];

/** The export, with `preamble` lines of prose before the blank line. */
function exportText(preamble: string[]): string {
  return [...preamble, "", STOCK_HEADERS, ...DATA_ROWS].join("\n");
}

const REAL_EXPORT = exportText(["Notes:", NOTES_PARAGRAPH]);

// ------------------------------------------------------------- the preamble

describe("LinkedIn's preamble", () => {
  it("is skipped by the header sniffer the app already had, not by a LinkedIn if", () => {
    // `sniffHeaderRow` picks the first row that names every column with data
    // below it and reports its reasoning in words. That is the machinery P9 paid
    // for, and reusing it is what makes this import survive LinkedIn changing the
    // preamble — which it has done twice.
    const parsed = readDelimited(REAL_EXPORT);
    // Papaparse drops the blank line (`skipEmptyLines: "greedy"`), so the header
    // is the THIRD row of the parse: `Notes:`, the paragraph, then the columns.
    expect(parsed.rows[0]).toEqual(["Notes:"]);
    expect(parsed.rows[1]).toHaveLength(1);
    expect(parsed.delimiter).toBe(",");

    const sniff = sniffHeaderRow(parsed.rows);
    expect(sniff.index).toBe(2);
    expect(parsed.rows[sniff.index]).toEqual([
      "First Name",
      "Last Name",
      "URL",
      "Email Address",
      "Company",
      "Position",
      "Connected On",
    ]);
    // Mutant: `sniffHeaderRow` returning 0. Then `Notes:` is the header, the
    // whole export is one column called `Notes:`, and the import reports 3,000
    // successful rows.
    expect(parsed.rows[0]).not.toEqual(parsed.rows[sniff.index]);
  });

  it("says in words WHY it skipped, rather than skipping silently", () => {
    // The reason is rendered next to the "first row is data" toggle. A guess with
    // no stated evidence is one nobody can overrule.
    const sniff = sniffHeaderRow(readDelimited(REAL_EXPORT).rows);
    expect(sniff.reason).toContain("row 1 is blank in 6 column(s) that have values below it");
    expect(sniff.reason).toContain("row 3 names all of them");
    // And it is NOT flagged uncertain: every chosen cell is a word, so the toggle
    // is available but not demanded.
    expect(sniff.uncertain).toBe(false);
  });

  it("finds the header whether the preamble is 2 lines or 4", () => {
    // A hardcoded skip-N breaks silently the third time LinkedIn edits its own
    // notes, and "silently" is the whole problem: the file still parses.
    const two = sniffHeaderRow(readDelimited(exportText(["Notes:"])).rows);
    expect(two.index).toBe(1);

    const four = sniffHeaderRow(
      readDelimited(
        exportText(["Notes:", NOTES_PARAGRAPH, '"A second paragraph, with a comma in it."']),
      ).rows,
    );
    expect(four.index).toBe(3);

    // The control that makes the two above mean something: a file with NO
    // preamble still answers row 1, so the sniffer is not simply counting.
    const bare = sniffHeaderRow(readDelimited([STOCK_HEADERS, ...DATA_ROWS].join("\n")).rows);
    expect(bare.index).toBe(0);
  });
});

// --------------------------------------------------------------- the mapping

describe("suggestConnectionMapping over LinkedIn's stock headers", () => {
  const headers = STOCK_HEADERS.split(",");
  const mapping = suggestConnectionMapping(headers);

  it("maps every column LinkedIn writes by EXACT alias, with no fuzzy pass at all", () => {
    // A stock export must not depend on the 0.82 floor for anything. Fuzzy is for
    // the hand-kept sheet and the Google Contacts export; the vendor's own file
    // is a file we know the columns of.
    expect(mapping.firstName).toEqual({
      header: "First Name",
      index: 0,
      confidence: 1,
      source: "alias",
    });
    expect(mapping.lastName).toEqual({
      header: "Last Name",
      index: 1,
      confidence: 1,
      source: "alias",
    });
    expect(mapping.profileUrl).toEqual({ header: "URL", index: 2, confidence: 1, source: "alias" });
    expect(mapping.company).toEqual({ header: "Company", index: 4, confidence: 1, source: "alias" });
    // LinkedIn's header is "Position"; the schema's word is `title`, so that
    // aliasing is load-bearing rather than cosmetic.
    expect(mapping.title).toEqual({ header: "Position", index: 5, confidence: 1, source: "alias" });
    expect(mapping.connectedOn).toEqual({
      header: "Connected On",
      index: 6,
      confidence: 1,
      source: "alias",
    });
    // Mutant: remove any single alias above and it falls to `source: "fuzzy"` or
    // to null — this loop is what notices either.
    for (const field of CONNECTION_FIELDS) {
      const s = mapping[field];
      if (s) expect(s.source, `${field} was matched fuzzily`).toBe("alias");
    }
  });

  it("leaves fullName unmapped, because LinkedIn splits the name", () => {
    // Not an oversight: the export has no whole-name column, and `joinName` is
    // what puts the two halves back together. A mapper that guessed "First Name"
    // into `fullName` would file everybody under their first name alone.
    expect(mapping.fullName).toBeNull();
  });

  it("maps Email Address to NOTHING, and says so in the report", () => {
    // Deliberate. This app has no use for a connection's email — outreach happens
    // on LinkedIn, by hand, from the user's own account — and storing it "just in
    // case" would put a pile of personal email addresses in a database for a
    // feature nobody has. A column that lands nowhere shows up as "unmapped",
    // which is the honest description of a field we chose not to store.
    //
    // Mutant: add "email"/"email address" to any alias list. This goes red, and
    // it is the only thing that would notice.
    expect(unmappedConnectionHeaders(headers, mapping)).toEqual(["Email Address"]);
    for (const field of CONNECTION_FIELDS) {
      expect(mapping[field]?.header, `${field} took the email column`).not.toBe("Email Address");
    }
  });

  it("still maps a hand-kept sheet, which is what the extra aliases are for", () => {
    // The positive control for the alias table being wider than one vendor.
    const m = suggestConnectionMapping(["Name", "Employer", "Role", "LinkedIn", "Since"]);
    expect(m.fullName?.header).toBe("Name");
    expect(m.company?.header).toBe("Employer");
    expect(m.title?.header).toBe("Role");
    expect(m.profileUrl?.header).toBe("LinkedIn");
    expect(m.connectedOn?.header).toBe("Since");
  });
});

describe("CONNECTION_ALIASES", () => {
  it("gives no alias to two fields at once", () => {
    // If one normalized word owned two fields, which one won would depend on the
    // order of an object literal rather than on anything true. (`map-columns.test.ts`
    // asserts the same property for the applications table; this is its shape.)
    const owners = new Map<string, string[]>();
    for (const field of CONNECTION_FIELDS) {
      for (const alias of CONNECTION_ALIASES[field]) {
        owners.set(alias, [...(owners.get(alias) ?? []), field]);
      }
    }
    const shared = [...owners.entries()].filter(([, fields]) => fields.length > 1);
    expect(shared).toEqual([]);
  });

  it("spells every alias in normalized form, so it can actually be hit", () => {
    // An alias with a capital or a hyphen in it is an alias that can never match,
    // because the header is normalized before the lookup and the alias is not.
    for (const field of CONNECTION_FIELDS) {
      for (const alias of CONNECTION_ALIASES[field]) {
        expect(normalizeHeader(alias), `${field}: ${alias}`).toBe(alias);
      }
    }
  });

  it("covers every field the import can write", () => {
    for (const field of CONNECTION_FIELDS) {
      expect(CONNECTION_ALIASES[field].length, `${field} has no aliases`).toBeGreaterThan(0);
    }
  });
});

describe("the shared suggestion algorithm (lib/import/suggest.ts)", () => {
  it("is ONE algorithm — map-columns re-exports these, it does not own copies", () => {
    // The extraction's whole point. `map-columns.ts` re-exports
    // `diceCoefficient`/`normalizeHeader`/`FUZZY_FLOOR` so every existing
    // importer keeps its path, and a second copy is a second 0.82 floor that
    // drifts the first time somebody tunes one of them.
    //
    // Identity, not equality: two functions that happen to agree today are still
    // two functions, and `toBe` on a function reference is what notices a copy.
    expect(mapColumns.diceCoefficient).toBe(diceCoefficient);
    expect(mapColumns.normalizeHeader).toBe(normalizeHeader);

    // The floor is a NUMBER, so there is no identity to check — a hand-copied
    // `0.82` is `toBe`-equal to the real one and a mutant that declares a second
    // copy survives this file. (Watched: it did.) So the copy is refused at the
    // source instead, which is the same technique `parity.test.ts` uses when
    // there is nothing runtime left to compare.
    expect(mapColumns.FUZZY_FLOOR).toBe(FUZZY_FLOOR);
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "lib", "import", "map-columns.ts"),
      "utf8",
    );
    // Written against the SHAPE rather than one spelling of it: `export { … }`
    // and `export { … } from "./suggest"` are both re-exports and both fine. What
    // is refused is a second declaration.
    expect(source).toMatch(/export\s*\{[^}]*\bFUZZY_FLOOR\b[^}]*\}/);
    expect(source).toContain('from "./suggest"');
    expect(source).not.toMatch(/(?:const|let|var)\s+FUZZY_FLOOR\s*=/);
  });

  it("assigns the best (field, header) pair GLOBALLY, not in field order", () => {
    // `fullName` is declared before `connectedOn`, and "connection dat" clears
    // the floor for both — 0.86 against `fullName`'s "connection" alias, 0.96
    // against `connectedOn`'s "connection date". Looping fields in declaration
    // order files somebody's connection dates under their NAME, and the report
    // shows a mapped column either way.
    //
    // The header is contrived, and deliberately so: it is the only shape in this
    // vocabulary where two fields clear the floor at different scores, which is
    // the point — the property belongs to the algorithm, not to the alias table,
    // and `map-columns.test.ts`'s version of this claim uses an input where the
    // second field does not clear the floor at all, so it survives the mutation
    // (sort by `a.order` before `b.score` in `suggestFor`) that this one catches.
    const m = suggestConnectionMapping(["Connection Dat"]);
    expect(diceCoefficient(normalizeHeader("Connection Dat"), "connection")).toBeGreaterThan(
      FUZZY_FLOOR,
    );
    expect(m.connectedOn).toMatchObject({ header: "Connection Dat", source: "fuzzy" });
    expect(m.fullName).toBeNull();
  });
});

// ----------------------------------------------------------------- the date

describe("readConnectedOn", () => {
  it("reads the three unambiguous shapes the column actually holds", () => {
    // All three are unambiguous BY CONSTRUCTION — a named month has no day/month
    // order to guess wrong, and year-first is year-first.
    expect(readConnectedOn("21 Mar 2023").iso).toBe("2023-03-21"); // what LinkedIn writes today
    expect(readConnectedOn("Mar 21, 2023").iso).toBe("2023-03-21"); // what it wrote before
    expect(readConnectedOn("2023-03-21").iso).toBe("2023-03-21"); // a spreadsheet tidy-up
    // Longer month names and the stray punctuation exports pick up.
    expect(readConnectedOn("21 March 2023").iso).toBe("2023-03-21");
    expect(readConnectedOn("Sept. 3, 2021").iso).toBe("2021-09-03");
    expect(readConnectedOn("2023-3-1").iso).toBe("2023-03-01"); // padded on the way out
  });

  it("REFUSES 03/04/2026 rather than guessing which half is the month", () => {
    // 3 April in most of the world, 4 March in the US, and the file does not say.
    // This column is decoration on a popover, so a wrong date is one nobody
    // re-reads — precisely the failure `readDate` was written to refuse.
    // Mutant: add a `\d{1,2}/\d{1,2}/\d{4}` branch. This goes red.
    const r = readConnectedOn("03/04/2026");
    expect(r.iso).toBeNull();
    expect(r.reason).toContain("without guessing");
    expect(r.reason).toContain("03/04/2026");
  });

  it("refuses a date that is not a day", () => {
    // `2023-02-29` parses cleanly and does not exist; `new Date()` rolls it
    // silently to 1 March. Mutant: drop the UTC round-trip in `finishDate` and
    // this returns 2023-03-01 — a real connection filed under a date that never
    // happened.
    const r = readConnectedOn("2023-02-29");
    expect(r.iso).toBeNull();
    expect(r.reason).toContain("not a day that exists");
    expect(readConnectedOn("31 Apr 2023").iso).toBeNull();
    expect(readConnectedOn("2023-13-01").iso).toBeNull();
    // Positive control: the leap day that DOES exist still reads.
    expect(readConnectedOn("2024-02-29").iso).toBe("2024-02-29");
  });

  it("calls an empty cell empty, by that name", () => {
    // The preview distinguishes "the file did not say" from "the file said
    // something I cannot read", and only the second is worth reporting.
    expect(readConnectedOn("")).toEqual({ iso: null, reason: "empty" });
    expect(readConnectedOn("   ")).toEqual({ iso: null, reason: "empty" });
    expect(readConnectedOn(null as never)).toEqual({ iso: null, reason: "empty" });
  });

  it("never answers null without a reason — a null date with no reason is a shrug", () => {
    for (const value of [
      "",
      "   ",
      "03/04/2026",
      "2023-02-29",
      "sometime in 2019",
      "Marchember 4, 2020",
      "2023",
      "21 Mar",
    ]) {
      const r = readConnectedOn(value);
      if (r.iso === null) {
        expect(r.reason.trim(), `${JSON.stringify(value)} produced a reasonless null`).not.toBe("");
      }
    }
    // And a reading also carries its reason, so the UI never has to say
    // "imported" without being able to say why it believed the date.
    expect(readConnectedOn("21 Mar 2023").reason).toBe("day, named month, year");
    expect(readConnectedOn("Mar 21, 2023").reason).toBe("named month, day, year");
    expect(readConnectedOn("2023-03-21").reason).toBe("year-first, unambiguous");
  });
});

// ----------------------------------------------------------------- the name

describe("joinName", () => {
  it("lets an explicit full-name column win over first + last", () => {
    // A file carrying all three columns must not produce "Ada Lovelace Ada
    // Lovelace". Mutant: `[full, first, last].filter(Boolean).join(" ")`.
    expect(joinName({ fullName: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada Lovelace",
    );
    // …including when the parts disagree with the whole, which is the case that
    // proves which one is authoritative.
    expect(joinName({ fullName: "Ada, Countess of Lovelace", firstName: "Ada", lastName: "L" })).toBe(
      "Ada, Countess of Lovelace",
    );
  });

  it("joins first and last when that is all the file has", () => {
    expect(joinName({ firstName: "Ada", lastName: "Lovelace" })).toBe("Ada Lovelace");
    expect(joinName({ firstName: " Ada ", lastName: " Lovelace " })).toBe("Ada Lovelace");
  });

  it("lets a mononym survive", () => {
    // One name is a name. Mutant: requiring both parts drops these people from
    // the import entirely, and they are counted as `skipped` with no explanation.
    expect(joinName({ firstName: "Cher" })).toBe("Cher");
    expect(joinName({ lastName: "Bono" })).toBe("Bono");
    expect(joinName({ fullName: "Prince" })).toBe("Prince");
  });

  it("answers the empty string when every part is blank", () => {
    expect(joinName({})).toBe("");
    expect(joinName({ fullName: "  ", firstName: "  ", lastName: "" })).toBe("");
  });
});

// -------------------------------------------------------------- the mapping

describe("applyConnectionMapping reads by column INDEX, never by header name", () => {
  it("takes the value from the mapped index when two columns share a name", () => {
    // LinkedIn's export has genuinely shipped duplicate headers, and a by-name
    // reader gives a coin flip whose loser is silently not imported. Mutant:
    // resolve `at()` through `headers.indexOf(mapping[field].header)` — the
    // second URL column becomes unreachable and every one of these people loses
    // their profile link.
    const headers = ["First Name", "Last Name", "URL", "URL"];
    const suggested = suggestConnectionMapping(headers);
    // The leftmost URL wins the alias, as it should.
    expect(suggested.profileUrl?.index).toBe(2);

    // The person then picks the OTHER one on the mapping screen, because the
    // first column is the empty one.
    const chosen: ConnectionMapping = {
      ...suggested,
      profileUrl: { header: "URL", index: 3, confidence: 1, source: "alias" },
    };
    const rows = [["Ada", "Okonkwo", "", "https://www.linkedin.com/in/ada"]];
    expect(applyConnectionMapping(rows, chosen)[0].profileUrl).toBe(
      "https://www.linkedin.com/in/ada",
    );
    // Positive control on the same data: the auto-suggested mapping reads the
    // empty first column, so the assertion above is about the INDEX and not about
    // the row happening to contain a URL anywhere.
    expect(applyConnectionMapping(rows, suggested)[0].profileUrl).toBe("");
  });

  it("answers empty strings for a field nothing was mapped to", () => {
    const mapping = suggestConnectionMapping(["Name"]);
    const [draft] = applyConnectionMapping([["Ada Lovelace"]], mapping);
    expect(draft.fullName).toBe("Ada Lovelace");
    expect(draft.company).toBe("");
    expect(draft.title).toBe("");
    expect(draft.profileUrl).toBe("");
    expect(draft.connectedOn).toBeNull();
    expect(draft.dateReason).toBe("empty");
  });

  it("numbers rows from 1, so the preview can point at a line in the file", () => {
    const mapping = suggestConnectionMapping(["Name"]);
    const drafts = applyConnectionMapping([["A"], ["B"], ["C"]], mapping);
    expect(drafts.map((d) => d.rowNumber)).toEqual([1, 2, 3]);
  });

  it("survives a short row without inventing a value for the missing cell", () => {
    // Real exports have ragged rows. `row[index]` is undefined there, and the
    // alternative to answering "" is a crash on somebody's 2,900th line.
    const mapping = suggestConnectionMapping(STOCK_HEADERS.split(","));
    const [draft] = applyConnectionMapping([["Ada", "Okonkwo"]], mapping);
    expect(draft.fullName).toBe("Ada Okonkwo");
    expect(draft.company).toBe("");
  });
});

// -------------------------------------------------------------- the preview

describe("previewConnections", () => {
  /** The whole pipeline, exactly as the wizard runs it. */
  function parse(text: string) {
    const parsed = readDelimited(text);
    const sniff = sniffHeaderRow(parsed.rows);
    const headers = parsed.rows[sniff.index];
    const mapping = suggestConnectionMapping(headers);
    return applyConnectionMapping(parsed.rows.slice(sniff.index + 1), mapping);
  }

  const universeKeys = new Set(
    FIXTURE_COMPANIES.map((c) => companyNameKey(c.name)).filter((k) => k !== ""),
  );
  const drafts = parse(REAL_EXPORT);
  const preview = previewConnections(drafts, universeKeys);

  it("counts the file, the people, and the difference between them", () => {
    expect(preview.total).toBe(7);
    expect(preview.named).toBe(6);
    // Stated rather than inferred: the screen says "1 line has no name" and the
    // number has to come from somewhere a test can check.
    expect(preview.unnamed).toBe(1);
    expect(preview.unnamed).toBe(preview.total - preview.named);
  });

  it("collapses duplicates the way the commit will — the same URL, and the same (name, company)", () => {
    // A preview that counted ROWS would promise more than the commit delivers on
    // every re-import, and re-importing monthly is the entire usage pattern.
    // Seven lines, six named, and only four people: Ada appears twice under one
    // profile URL, and Bo twice with no URL at all.
    expect(preview.distinct).toBe(4);
    // Mutant: `distinct: named.length` — this goes red and nothing else does.
    expect(preview.distinct).toBeLessThan(preview.named);
  });

  it("counts distinct companies, and how many of them this user actually watches", () => {
    // `matchedCompanies` is the whole value proposition in one integer: it is
    // what tells somebody whether their export is worth uploading.
    expect(preview.companies).toBe(3); // Ramp, Fifth Third Bank, Anthropic
    expect(preview.matchedCompanies).toBe(2); // …Anthropic is in nobody's universe
    // The Fifth Third row is the one with teeth, and it is why the corpus spells
    // that company with an NBSP: the universe spells it with a plain space, so a
    // mutant using `d.company.toLowerCase()` in place of `companyNameKey(...)`
    // drops the count to 1 \u2014 and the screen then tells somebody their export is
    // half as useful as it really is.
    const plainSpaceUniverse = new Set([companyNameKey("Fifth Third Bank")]);
    expect(previewConnections(drafts, plainSpaceUniverse).matchedCompanies).toBe(1);
    // The empty-universe control: nothing matches, and the count is 0 rather than
    // the company count.
    expect(previewConnections(drafts, new Set<string>()).matchedCompanies).toBe(0);
  });

  it("counts unreadable dates without counting empty ones", () => {
    // The column is optional, so a blank is not a problem to report. `03/04/2026`
    // is, because the person may want to fix it before committing.
    expect(preview.unreadableDates).toBe(1);
    const withoutDates = parse(
      [STOCK_HEADERS, ",,,,Ramp,PM,", "Ada,Okonkwo,,,Ramp,PM,"].join("\n"),
    );
    expect(previewConnections(withoutDates, universeKeys).unreadableDates).toBe(0);
  });

  it("shows up to five named rows and never a nameless one", () => {
    expect(preview.samples).toHaveLength(5);
    for (const sample of preview.samples) expect(sample.fullName).not.toBe("");
    expect(preview.samples[0].fullName).toBe("Ada Okonkwo");
    expect(preview.samples[0].title).toBe("Product Manager");
  });

  it("promises exactly what a commit inserts", () => {
    // The assertion that makes `distinct` a promise rather than a statistic: the
    // same drafts, through the data source that models `app_import_connections`,
    // into an empty store. If the preview's identity ever drifts from the SQL's,
    // this is where it shows — and the alternative is a screen that says 6 and a
    // report that says 4.
    const store = new FixtureDataSource(undefined, undefined, undefined, undefined, undefined, []);
    const rows = toImportRows(drafts);
    return store
      .importConnections({ rows, source: "linkedin-export", idempotencyKey: "preview-vs-commit" })
      .then((result) => {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.inserted).toBe(preview.distinct);
        expect(result.updated).toBe(0);
        // And the report closes on the rows sent (matrix row 169).
        expect(result.inserted + result.updated + result.skipped + result.deduped).toBe(rows.length);
      });
  });
});

// ------------------------------------------------------------- the wire rows

describe("toImportRows", () => {
  const drafts = applyConnectionMapping(
    [
      ["Ada", "Okonkwo", "https://www.linkedin.com/in/ada", "ada@example.com", "Ramp", "PM", "21 Mar 2023"],
      ["", "", "", "nobody@example.com", "Ghost Holdings", "Analyst", ""],
    ],
    suggestConnectionMapping(STOCK_HEADERS.split(",")),
  );

  it("drops the nameless rows, because a nameless row is not a person you can ask", () => {
    expect(drafts).toHaveLength(2); // positive control: both were parsed
    const rows = toImportRows(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0].fullName).toBe("Ada Okonkwo");
  });

  it("carries the seven wire fields and nothing else", () => {
    // `rowNumber` and `dateReason` are preview-only. Sending them would put two
    // columns into a jsonb argument the SQL does not read, which is harmless
    // right up until somebody adds a column by that name.
    expect(Object.keys(toImportRows(drafts)[0]).sort()).toEqual([
      "company",
      "connectedOn",
      "firstName",
      "fullName",
      "lastName",
      "profileUrl",
      "title",
    ]);
  });

  it("keeps the date as ISO-or-null, never as the file's own spelling", () => {
    expect(toImportRows(drafts)[0].connectedOn).toBe("2023-03-21");
    const unreadable = applyConnectionMapping(
      [["Bo", "L", "", "", "Ramp", "EM", "03/04/2026"]],
      suggestConnectionMapping(STOCK_HEADERS.split(",")),
    );
    expect(toImportRows(unreadable)[0].connectedOn).toBeNull();
  });
});

describe("CONNECTION_SOURCE_TAGS", () => {
  it("is the closed set the import door accepts", () => {
    // Closed at both ends: the tags here are the tags `app_import_connections`
    // allows, and `parity.test.ts` pins the two lists to each other.
    expect([...CONNECTION_SOURCE_TAGS]).toEqual(["linkedin-export", "manual", "import"]);
  });
});
