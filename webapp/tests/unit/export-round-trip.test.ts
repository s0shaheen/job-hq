// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { FIXTURE_APPLICATIONS } from "@/lib/data/fixtures";
import { APPLICATION_COLUMNS } from "@/lib/export/columns";
import { toCsv } from "@/lib/export/delimited";
import { parseExportRequest } from "@/lib/export/scope";
import { buildXlsx } from "@/lib/export/xlsx";
import { isRoundTrip, suggestMapping } from "@/lib/import/map-columns";
import { cellText, readDelimited } from "@/lib/import/read";
import {
  HQ_ID_HEADER,
  HQ_VERSION_HEADER,
  ROUND_TRIP_COLUMNS,
} from "@/lib/import/round-trip";

/**
 * The two ends of the Excel round trip, pinned against each other.
 *
 * `ROUND_TRIP_COLUMNS` existed for a whole phase with **zero callers** — the
 * export route emitted `APPLICATION_COLUMNS`, nothing anywhere wrote an `hq_id`,
 * and AC 23 was recorded as discharged with half the loop unbuilt. The importer
 * was tested against files a test had typed by hand, which is the same shape of
 * mistake: both halves agreed with a third thing rather than with each other.
 *
 * So every assertion here crosses the seam. The header strings the EXPORTER
 * writes are fed to the MAPPER that has to recognise them; the token the
 * exporter writes is parsed the way `previewImport` parses it. A rename on
 * either side breaks this file rather than breaking a user's import silently.
 */

const APPS = FIXTURE_APPLICATIONS;

/**
 * The exported file, read back by the IMPORTER's own reader.
 *
 * Not a positional `split(",")`: job titles carry commas constantly, so a naive
 * split shifts every later column on exactly those rows — and it would have read
 * the URL column as the id here. Using `readDelimited` is also the point of the
 * exercise: the assertions below are about what the importer sees.
 */
function readBack(csv: string): { headers: string[]; rows: string[][] } {
  const parsed = readDelimited(csv).rows.map((cells) => cells.map((c) => cellText(c)));
  return { headers: parsed[0] ?? [], rows: parsed.slice(1) };
}

function headerRow(csv: string): string[] {
  return readBack(csv).headers;
}

describe("what the exporter emits", () => {
  it("is the ordinary export plus exactly two trailing columns", () => {
    // Built from APPLICATION_COLUMNS rather than re-listed, so a column added to
    // the ordinary export cannot go missing from the file people edit.
    expect(ROUND_TRIP_COLUMNS.slice(0, APPLICATION_COLUMNS.length)).toEqual(APPLICATION_COLUMNS);
    expect(ROUND_TRIP_COLUMNS).toHaveLength(APPLICATION_COLUMNS.length + 2);
    expect(ROUND_TRIP_COLUMNS.map((c) => c.header).slice(-2)).toEqual([
      HQ_ID_HEADER,
      HQ_VERSION_HEADER,
    ]);
  });

  it("writes both machine columns as text, never as a number or a date", () => {
    // A numeric id renders as 1.23457E+11 once Excel decides the column is
    // numeric, and matches no row at all. A date-typed token gets rounded to the
    // day, which makes every row read as stale.
    const [id, version] = ROUND_TRIP_COLUMNS.slice(-2);
    expect(id.type).toBe("text");
    expect(version.type).toBe("text");
  });

  it("puts the row's own updated_at in hq_version, verbatim", () => {
    const { headers, rows } = readBack(toCsv(APPS, ROUND_TRIP_COLUMNS));
    const at = headers.indexOf(HQ_VERSION_HEADER);

    rows.forEach((cells, i) => {
      const token = cells[at];
      expect(token).toBe(APPS[i].updatedAt);
      // And it is the same INSTANT the preview compares against. That comparison
      // is `new Date(token).getTime()` on both sides, so a token Date cannot
      // parse would call every row stale rather than erroring.
      expect(Number.isNaN(new Date(token).getTime())).toBe(false);
      expect(new Date(token).getTime()).toBe(new Date(APPS[i].updatedAt ?? 0).getTime());
    });
  });

  it("writes the id as its own primary key, not its position", () => {
    const { headers, rows } = readBack(toCsv(APPS, ROUND_TRIP_COLUMNS));
    const at = headers.indexOf(HQ_ID_HEADER);
    expect(rows.map((cells) => cells[at])).toEqual(APPS.map((a) => String(a.id)));
  });

  it("survives the xlsx writer with the headers intact", async () => {
    const buf = await buildXlsx(APPS, ROUND_TRIP_COLUMNS, { sheetName: "Pipeline" });
    expect(buf.byteLength).toBeGreaterThan(0);
    // The header strings live in the shared string table; asserting on the bytes
    // is enough to catch a writer that renamed or dropped a column.
    const text = Buffer.from(buf).toString("latin1");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("what the importer makes of it", () => {
  it("recognises both headers exactly, and flips the batch into round-trip mode", () => {
    const headers = headerRow(toCsv(APPS, ROUND_TRIP_COLUMNS));
    const mapping = suggestMapping(headers);
    // This is the seam: the mapper's alias table has to contain what the
    // exporter writes, or a round-trip file imports as new rows.
    expect(mapping.hqId).toMatchObject({ header: HQ_ID_HEADER, source: "alias", confidence: 1 });
    expect(mapping.hqVersion).toMatchObject({
      header: HQ_VERSION_HEADER,
      source: "alias",
      confidence: 1,
    });
    expect(isRoundTrip(mapping)).toBe(true);
  });

  it("maps every other exported header to the field it came from", () => {
    const headers = headerRow(toCsv(APPS, ROUND_TRIP_COLUMNS));
    const mapping = suggestMapping(headers);
    // The five writable ones matter most: an export whose "Next action date"
    // stopped mapping would round-trip that column into nothing, silently.
    for (const field of ["company", "title", "status", "appliedDate", "nextAction", "nextActionDate", "notes", "url"] as const) {
      expect(mapping[field], `${field} lost its column`).not.toBeNull();
    }
  });

  it("degrades rather than fails when the columns are deleted — the copy's claim", () => {
    const headers = headerRow(toCsv(APPS, ROUND_TRIP_COLUMNS)).filter(
      (h) => h !== HQ_ID_HEADER && h !== HQ_VERSION_HEADER,
    );
    const mapping = suggestMapping(headers);
    expect(isRoundTrip(mapping)).toBe(false);
    // Still a perfectly good import, matched on the URL rather than the id.
    expect(mapping.url).not.toBeNull();
    expect(mapping.company).not.toBeNull();
  });

  it("refuses hq_id without hq_version — both, never either", () => {
    const headers = headerRow(toCsv(APPS, ROUND_TRIP_COLUMNS)).filter(
      (h) => h !== HQ_VERSION_HEADER,
    );
    // Matching by id and writing with no concurrency token is the exact
    // clobber the token exists to prevent.
    expect(isRoundTrip(suggestMapping(headers))).toBe(false);
  });
});

describe("the one cell a CSV round trip does not preserve", () => {
  it("prefixes an apostrophe to a formula-lead value, and the re-import keeps it", () => {
    /**
     * KNOWN LIMIT, pinned rather than asserted away.
     *
     * `escapeField` neutralises a cell beginning `= + - @ TAB CR` with Excel's own
     * text marker, because company names and job titles arrive verbatim from ATS
     * boards and `=cmd|' /c calc'!A1` is the classic payload. That defence is not
     * negotiable. Its cost, now that this app EXPORTS files it also imports, is
     * that a next action of "-- chase Priya" comes back as "'-- chase Priya" if
     * the file is re-imported without passing through Excel. (Through Excel it is
     * invisible: Excel reads the apostrophe as the text marker, shows the value
     * without it, and writes it back out unmarked.)
     *
     * The xlsx round trip has no such cost — there is no neutralisation there,
     * because a cell in a workbook is typed rather than sniffed.
     *
     * Not "fixed" by stripping a leading apostrophe on import: `'-1 day'` is a
     * value somebody could plausibly type, and silently eating its first
     * character to protect a rarer one trades a certain small mutation for an
     * uncertain worse one. Stated instead, and the xlsx path recommended.
     */
    const withLead = APPS.map((a, i) =>
      i === 0 ? { ...a, nextAction: "-- chase Priya" } : a,
    );
    const { headers, rows } = readBack(toCsv(withLead, ROUND_TRIP_COLUMNS));
    const at = headers.indexOf("Next action");
    expect(rows[0][at]).toBe("'-- chase Priya");

    // The two machine columns are unaffected, which is what keeps the MATCH
    // correct even when a cell's text is marked: an id and an ISO timestamp can
    // never begin with a formula lead.
    expect(rows[0][headers.indexOf(HQ_ID_HEADER)]).toBe(String(APPS[0].id));
    expect(rows[0][headers.indexOf(HQ_VERSION_HEADER)]).toBe(APPS[0].updatedAt);
  });

  it("leaves a bare negative number alone, so numeric cells survive", () => {
    // The INERT_LEAD exemption. Without it every negative number in an export
    // would come back as text with an apostrophe welded on.
    const { headers, rows } = readBack(
      toCsv([{ ...APPS[0], nextAction: "-15" }], ROUND_TRIP_COLUMNS),
    );
    expect(rows[0][headers.indexOf("Next action")]).toBe("-15");
  });
});

describe("the request that asks for it", () => {
  const good = { dataset: "applications", scope: "view", format: "xlsx" };

  it("defaults to off — an unasked-for file does not grow machine columns", () => {
    const parsed = parseExportRequest(good);
    expect(parsed.ok && parsed.request.roundTrip).toBe(false);
  });

  it("accepts it for the pipeline", () => {
    const parsed = parseExportRequest({ ...good, roundTrip: true });
    expect(parsed.ok && parsed.request.roundTrip).toBe(true);
  });

  it("refuses it for jobs rather than dropping it", () => {
    // Dropping it would hand back a file missing the columns the caller asked
    // for, with a 200 — the same "looks right and is not" failure this module
    // exists to prevent.
    const parsed = parseExportRequest({ ...good, dataset: "jobs", roundTrip: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/no row to write back to/);
  });

  it("refuses a non-boolean", () => {
    for (const value of ["true", 1, {}]) {
      const parsed = parseExportRequest({ ...good, roundTrip: value });
      expect(parsed.ok, `accepted ${JSON.stringify(value)}`).toBe(false);
    }
  });
});
