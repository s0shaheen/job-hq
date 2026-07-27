import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  exportFilename,
  MAX_EXPORT_KEYS,
  parseExportRequest,
  sheetNameFor,
} from "@/lib/export/scope";

/**
 * The request model is the trust boundary of the export feature.
 *
 * "Silently exporting only the filtered subset is a top-tier trust bug" — the
 * same is true of silently exporting the wrong dataset, or of a malformed
 * request quietly degrading to a default. Every rejection below exists so a
 * confused request fails loudly instead of producing a plausible wrong file.
 */

const good = { dataset: "jobs", scope: "view", format: "csv", keys: ["greenhouse-1"] };

describe("parsing", () => {
  it("accepts a well-formed request", () => {
    const r = parseExportRequest(good);
    expect(r).toEqual({
      ok: true,
      request: {
        dataset: "jobs",
        scope: "view",
        format: "csv",
        keys: ["greenhouse-1"],
        // Absent means off. The round-trip columns are never added to a file
        // nobody asked to import back — see export-round-trip.test.ts.
        roundTrip: false,
      },
    });
  });

  it("allows a view scope with no keys, so the server resolves the view", () => {
    const r = parseExportRequest({ ...good, keys: undefined });
    expect(r.ok && r.request.keys).toBeNull();
  });

  it("rejects an unknown dataset rather than defaulting to one", () => {
    // Defaulting here would hand someone a file of the wrong table that looks
    // entirely legitimate.
    const r = parseExportRequest({ ...good, dataset: "postings" });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown format", () => {
    expect(parseExportRequest({ ...good, format: "pdf" }).ok).toBe(false);
  });

  it("rejects an unknown scope", () => {
    expect(parseExportRequest({ ...good, scope: "everything" }).ok).toBe(false);
  });

  it("rejects a selection scope with no keys instead of exporting nothing", () => {
    // An empty file is the worst outcome: it reads as "there was no data".
    const r = parseExportRequest({ ...good, scope: "selection", keys: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects more keys than the cap, rather than trying and timing out", () => {
    const keys = Array.from({ length: MAX_EXPORT_KEYS + 1 }, (_, i) => `k-${i}`);
    expect(parseExportRequest({ ...good, keys }).ok).toBe(false);
  });

  it("rejects keys that are not strings", () => {
    expect(parseExportRequest({ ...good, keys: [1, 2] }).ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(parseExportRequest(null).ok).toBe(false);
    expect(parseExportRequest("jobs").ok).toBe(false);
  });
});

describe("filenames", () => {
  it("names the dataset and the date so downloads do not collide", () => {
    expect(exportFilename("jobs", "xlsx", "2026-07-21")).toBe(
      "job-search-hq-jobs-2026-07-21.xlsx",
    );
    expect(exportFilename("applications", "csv", "2026-07-21")).toBe(
      "job-search-hq-applications-2026-07-21.csv",
    );
  });
});

describe("content types", () => {
  it("uses the exact XLSX type, or Excel refuses to open the download", () => {
    expect(contentTypeFor("xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("declares UTF-8 on CSV", () => {
    expect(contentTypeFor("csv")).toBe("text/csv; charset=utf-8");
  });
});

describe("sheet names", () => {
  it("stays within Excel's 31-character limit", () => {
    for (const d of ["jobs", "applications"] as const) {
      expect(sheetNameFor(d).length).toBeLessThanOrEqual(31);
      expect(sheetNameFor(d)).not.toMatch(/[:\\/?*[\]]/);
    }
  });
});
