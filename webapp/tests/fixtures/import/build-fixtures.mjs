#!/usr/bin/env node
/**
 * Builds every parser fixture under this directory.
 *
 *   node webapp/tests/fixtures/import/build-fixtures.mjs
 *
 * The fixtures are committed — this script exists so that a reviewer can see
 * exactly what is inside each byte, and so that "regenerate and diff" is a real
 * option when a library upgrade changes the output. Nothing in the test suite
 * runs it; the tests read the committed files.
 *
 * Why fixtures at all, instead of building strings inside the test: the bugs
 * this phase is guarding against are *byte* bugs. A windows-1252 file written
 * as a JS string literal is a UTF-8 file wearing a costume, and it would pass a
 * test that the real thing fails. Same for a BOM, same for CRLF, same for the
 * OLE2 header on a .xls. Every fixture below is written as bytes on purpose.
 *
 * The second half of the file builds the WIZARD-JOURNEY fixtures the E2E suite
 * drives end to end: clean-40.xlsx, weak-keys.csv, engine-columns.xlsx and
 * big-2000.xlsx. Each one is shaped against `FIXTURE_APPLICATIONS` in
 * `lib/data/fixtures.ts` — which company matches which row, and by which kind of
 * key — and the comments say which, because a fixture whose overlap with the
 * fixture set is accidental stops testing the thing it was built for the next time
 * somebody edits either.
 *
 * Deliberately NOT built here: `round-trip-conflict.xlsx`. A conflict needs a real
 * `hq_id`, and a committed fixture would hard-code an application id from the
 * fixture set — which would silently stop matching anything the day that set
 * changes, leaving a test that passes because it exercises nothing. The E2E builds
 * that file inside the test from an id read off the page.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import writeXlsxFile from "write-excel-file/node";

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const write = (name, bytes) => {
  writeFileSync(join(OUT, name), bytes);
  console.log(`${name}  ${bytes.length} bytes`);
};

// ---------------------------------------------------------------- delimited

/*
 * European Excel writes `;` when the locale's decimal separator is `,`. Nobody
 * who exports one knows that happened, so the file arrives looking like a
 * one-column spreadsheet whose single column contains the whole row.
 */
write(
  "semicolon.csv",
  Buffer.from(
    [
      "Company;Job Title;Status;Applied",
      "Acme;Product Manager;Applied;2026-01-04",
      "Globex;Senior PM, Payments;Screen;2026-02-11",
      "Initech;Staff PM;Rejected;2026-03-02",
      "",
    ].join("\n"),
    "utf8",
  ),
);

/*
 * BOM + CRLF: what Excel-for-Windows "Save as CSV UTF-8" produces. The BOM
 * rides on the first header cell, so `Company` becomes `\uFEFFCompany` and the
 * alias table misses it — the mapping screen then shows Company as Unmapped
 * over a file whose first column is plainly named Company.
 */
write(
  "crlf-bom.csv",
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      [
        "Company,Job Title,Status,Applied",
        "Acme,Product Manager,Applied,2026-01-04",
        "Globex,Senior PM,Screen,2026-02-11",
        "",
      ].join("\r\n"),
      "utf8",
    ),
  ]),
);

/*
 * Real windows-1252 bytes, not UTF-8 with accents in it.
 *
 *   0xEB  ë   0xF1  ñ   — also latin-1, so they prove the fallback ran
 *   0x92  ’   — cp1252 ONLY. latin-1 maps it to a C1 control character, so a
 *               fallback that quietly used latin-1 renders O<control>Reilly and
 *               this fixture catches it.
 *
 * All three are invalid UTF-8 continuation bytes, so the strict decode must
 * throw before the retry gets a chance to be wrong.
 */
/** windows-1252 encoder. Throws rather than guess for anything outside the page. */
const cp1252 = (s) =>
  Buffer.from(
    [...s].map((ch) => {
      // The cp1252-only slots this file uses. Everything else in 0x20-0xFF is
      // its own codepoint, which is where cp1252 and latin-1 agree.
      const c1 = { "\u201a": 0x82, "\u2018": 0x91, "\u2019": 0x92, "\u20ac": 0x80, "\u2026": 0x85 };
      if (c1[ch] !== undefined) return c1[ch];
      const code = ch.codePointAt(0);
      if (code > 0xff) throw new Error(`not representable in windows-1252: ${ch}`);
      return code;
    }),
  );

write(
  "windows-1252.csv",
  cp1252(
    [
      "Company,Contact,Status",
      "Zo\u00eb Industries,Zo\u00eb Hart,Applied",
      "Pe\u00f1a Labs,Ana Pe\u00f1a,Screen",
      "O\u2019Reilly Media,Tim O\u2019Reilly,Inbox",
      "",
    ].join("\n"),
  ),
);

/*
 * A UTF-8 BOM in front of a windows-1252 body. Excel-for-Windows writes the BOM
 * whenever "CSV UTF-8" is chosen, and plenty of tools then write the body in the
 * system codepage anyway.
 *
 * This is the fixture that makes the byte-level BOM strip load-bearing.
 * TextDecoder("utf-8") removes a BOM by itself, so on the happy path the manual
 * strip looks like dead code — but the strict UTF-8 decode fails here, and the
 * windows-1252 fallback would render EF BB BF as the visible "i>>?" prefix
 * welded to the first header cell.
 */
write(
  "bom-windows-1252.csv",
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    cp1252(["Company,Contact", "Zo\u00eb Industries,Tim O\u2019Reilly", ""].join("\n")),
  ]),
);

/*
 * A quoted field carrying a newline, a comma, and an escaped quote — one cell
 * that a hand-rolled `split(",")` turns into four rows of garbage.
 */
write(
  "quoted-newline.csv",
  Buffer.from(
    [
      "Company,Notes,Status",
      '"Acme, Inc.","Call back Tuesday.\nAsked about the ""platform"" role.",Screen',
      "Globex,Nothing yet,Applied",
      "",
    ].join("\n"),
    "utf8",
  ),
);

/*
 * No header row at all — someone pasted the body of their sheet. Guessing that
 * row 1 is headers here files their first application under a column named
 * "Acme", and it is invisible until they go looking for that row.
 */
write(
  "headers-are-data.csv",
  Buffer.from(
    [
      "Acme,Product Manager,2026-01-04,Applied",
      "Globex,Senior PM,2026-02-11,Screen",
      "Initech,Staff PM,2026-03-02,Rejected",
      "",
    ].join("\n"),
    "utf8",
  ),
);

/*
 * A title line above the real header row — the shape every "export" from a
 * hand-made tracker has. Row 1 has values in one column and blanks in the
 * three that carry data below, which is the tell.
 */
write(
  "preamble.csv",
  Buffer.from(
    [
      "My job tracker 2026,,,",
      "Company,Job Title,Status,Applied",
      "Acme,Product Manager,Applied,2026-01-04",
      "Globex,Senior PM,Screen,2026-02-11",
      "",
    ].join("\n"),
    "utf8",
  ),
);

/*
 * Trailing blank lines, including one made of nothing but a comma and spaces —
 * what deleting rows in Excel leaves behind. Counted as rows, they become three
 * empty applications nobody asked for.
 */
write(
  "blank-trailing.csv",
  Buffer.from(
    [
      "Company,Job Title,Status",
      "Acme,Product Manager,Applied",
      "Globex,Senior PM,Screen",
      "",
      "   ",
      "",
      "",
    ].join("\n"),
    "utf8",
  ),
);

// -------------------------------------------------------------------- xlsx

/*
 * 60 columns. The mapping UI has to survive it (matrix row 27) and the header
 * matcher has to stay deterministic when 60 candidates compete for 9 targets.
 */
{
  const headers = [
    "Company",
    "Job Title",
    "Status",
    "Applied",
    "URL",
    "Location",
    "Notes",
    "Next Action",
    "Next Action Date",
  ];
  while (headers.length < 60) headers.push(`Extra Field ${headers.length + 1}`);
  const row = (n) =>
    headers.map((h, i) =>
      i === 0 ? `Company ${n}` : i === 2 ? "Applied" : i === 3 ? "2026-01-0" + n : `${h} ${n}`,
    );
  const data = [
    headers.map((value) => ({ value, type: String, fontWeight: "bold" })),
    row(1).map((value) => ({ value, type: String })),
    row(2).map((value) => ({ value, type: String })),
  ];
  await writeXlsxFile(data, { sheet: "Applications" }).toFile(join(OUT, "wide-60.xlsx"));
  console.log("wide-60.xlsx  60 columns");
}

/*
 * The four shapes a date arrives in, in one sheet, so coerceDate is tested
 * against what a reader actually hands back rather than against a mock:
 *
 *   A  a real date cell            -> a JS Date
 *   B  a date serial typed as a number, no date format -> 45678
 *   C  an ISO string in a text cell -> "2026-03-04"
 *   D  "03/04/2026"                 -> 3 April or 4 March; the file does not say
 *
 * D is the one that matters. Every date library on npm will answer it, and half
 * of them answer differently. The only correct behaviour is to refuse.
 */
{
  const header = ["Real Date Cell", "Serial As Number", "ISO String", "Ambiguous String"].map(
    (value) => ({ value, type: String, fontWeight: "bold" }),
  );
  const row = [
    { value: new Date(Date.UTC(2026, 0, 15)), type: Date, format: "yyyy-mm-dd" },
    { value: 45678, type: Number },
    { value: "2026-03-04", type: String },
    { value: "03/04/2026", type: String },
  ];
  // Second row: Excel's Lotus 1-2-3 leap-year hole (serial 60 = 1900-02-29,
  // a day that never happened) and the serial immediately after it.
  const row2 = [
    { value: new Date(Date.UTC(1900, 2, 1)), type: Date, format: "yyyy-mm-dd" },
    { value: 60, type: Number },
    { value: "2026-02-29", type: String },
    { value: "3/4/26", type: String },
  ];
  await writeXlsxFile([header, row, row2], { sheet: "Dates" }).toFile(join(OUT, "dates.xlsx"));
  console.log("dates.xlsx  4 date shapes x 2 rows");
}

// ------------------------------------------------------- rejected on sight

/*
 * The three uploads that must fail by NAME rather than by stack trace.
 *
 * These are header fixtures, not complete files: the sniffer never opens the
 * container, it reads the first bytes and looks for the one marker that tells
 * the three OLE2/zip formats apart. Testing it against a header is testing it
 * against exactly what it reads. A 40 KB real .xls would prove nothing extra
 * and could not be reviewed by eye.
 */
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const utf16le = (s) => Buffer.from(s, "utf16le");

/** A CFB header plus a directory sector naming the stream the format uses. */
const cfb = (streamNames) => {
  const buf = Buffer.alloc(1024, 0);
  OLE2.copy(buf, 0);
  let at = 512; // first sector after the CFB header, where directory entries live
  for (const name of streamNames) {
    const bytes = utf16le(name);
    bytes.copy(buf, at);
    at += 128; // a CFB directory entry is 128 bytes
  }
  return buf;
};

// Excel 97-2003. Its workbook stream is literally named "Workbook".
write("fake.xls", cfb(["Workbook", "SummaryInformation"]));

// A password-protected .xlsx is not a zip at all — Office wraps the encrypted
// OOXML package in the same CFB container, under these two stream names.
write("encrypted.xlsx", cfb(["EncryptionInfo", "EncryptedPackage"]));

/** A stored (uncompressed) zip local file header for a zero-byte entry. */
const zipEntry = (name) => {
  const nameBytes = Buffer.from(name, "ascii");
  const h = Buffer.alloc(30, 0);
  h.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  h.writeUInt16LE(20, 4); // version needed to extract
  h.writeUInt16LE(0, 8); // method: stored
  h.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([h, nameBytes]);
};

// Apple Numbers is a zip, so the magic bytes alone say "xlsx". The entry names
// are what give it away, and telling someone "File -> Export To -> Excel" is
// the whole difference between a dead end and a thirty-second fix.
write(
  "fake.numbers",
  Buffer.concat([
    zipEntry("Index/Document.iwa"),
    zipEntry("Metadata/DocumentIdentifier"),
    zipEntry("Index/Tables/Tile-0.iwa"),
  ]),
);

// ------------------------------------------------- the wizard journey (E2E)

/** A header row, bold, as every export writes one. */
const head = (names) => names.map((value) => ({ value, type: String, fontWeight: "bold" }));
/** Text cells only. Dates ride as year-first STRINGS — see clean-40's note. */
const text = (values) => values.map((value) => ({ value: String(value), type: String }));

/*
 * clean-40.xlsx — the happy path, and the AC 20 fixture.
 *
 * Every URL is a real Greenhouse job link, which is the load-bearing detail: it
 * makes `job_key` a STRONG `greenhouse-<id>` key, so re-importing the same file
 * matches the rows the first import created instead of adding 40 more. With
 * example.com URLs the keys would be weak `norm-` keys, the second pass would read
 * as 40 suggestions, and the test would prove the opposite of what it claims.
 *
 * The ids are 45000xx so they cannot collide with the four posting keys in
 * FIXTURE_APPLICATIONS (4410982, 3f21a9c4, 8814021, 5540118), and the company
 * names avoid all seven fixture companies — a collision would turn a `new` row into
 * a match and move the counts the test asserts.
 *
 * Three deliberately awkward cells:
 *   * row 1's Applied date is `03/04/2026` — 3 April or 4 March, and the file does
 *     not say which. It must import with NO date rather than a guess, and because
 *     it is the first value in the column the mapping screen shows it as a sample
 *     marked "not a date".
 *   * `applied ` and `APPLIED` appear beside `Applied`, so the status step has to
 *     fold case and whitespace into one question rather than three.
 *   * `Awaiting recruiter` is a status this app does not have. It must land in Inbox
 *     with the original preserved in the notes, never mint a new stage.
 */
{
  const headers = [
    "Company",
    "Job Title",
    "Status",
    "Applied",
    "URL",
    "Location",
    "Notes",
    "Next Action",
    "Next Action Date",
  ];
  const stems = [
    "Kestrel", "Ironwood", "Bellweather", "Northgale", "Calder",
    "Marrow", "Oakhurst", "Pentland", "Quillon", "Ravelin",
  ];
  const suffixes = ["Labs", "Systems", "Group", "Partners"];
  const titles = [
    "Product Manager, Payments",
    "Product Manager, Platform",
    "Senior Product Manager",
    "Product Manager, Risk",
  ];
  const statuses = [
    "Applied",
    "applied ",
    "APPLIED",
    "Screen",
    "Rejected",
    "OA",
    "Awaiting recruiter",
  ];
  const cities = ["Chicago, IL", "Remote", "New York, NY", "Austin, TX"];

  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    const stem = stems[i % stems.length];
    rows.push(
      text([
        `${stem} ${suffixes[Math.floor(i / stems.length)]}`,
        titles[i % titles.length],
        statuses[i % statuses.length],
        i === 0 ? "03/04/2026" : `2026-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, "0")}`,
        `https://boards.greenhouse.io/${stem.toLowerCase()}/jobs/45000${String(i + 1).padStart(2, "0")}`,
        cities[i % cities.length],
        i % 5 === 0 ? "Referred by a friend." : "",
        i % 4 === 0 ? "Follow up" : "",
        i % 4 === 0 ? `2026-08-1${i % 9}` : "",
      ]),
    );
  }
  await writeXlsxFile([head(headers), ...rows], { sheet: "Applications" }).toFile(
    join(OUT, "clean-40.xlsx"),
  );
  console.log("clean-40.xlsx  40 data rows, strong greenhouse keys");
}

/*
 * weak-keys.csv — a row that LOOKS like one you already have, with no way to prove it.
 *
 * No URL column at all, so `job_key` falls back to `norm-<company>|<title>|<city>`
 * — a weak key. Row 1 is FIXTURE_APPLICATIONS[0] (Stripe, "Product Manager,
 * Billing") word for word, so the preview must call it a suggestion, insert it
 * SEPARATELY, and leave the real row alone: `isStrong()` is the only merge
 * authorisation in the system, and a weak key is a normalised guess at a company
 * and a title.
 *
 * Its status is `Offer` where the fixture row's is `Interview`, deliberately: if a
 * weak match ever did merge, the live row would move to Offer, so the assertion
 * that it is still Interview is one that can fail.
 *
 * The title carries a comma inside quotes, which is also the shape a hand-rolled
 * `split(",")` turns into two useless columns.
 */
write(
  "weak-keys.csv",
  Buffer.from(
    [
      "Company,Job Title,Status,Applied",
      '"Stripe","Product Manager, Billing",Offer,2026-02-02',
      '"Novello Systems","Product Manager, Growth",Applied,2026-03-03',
      "",
    ].join("\n"),
    "utf8",
  ),
);

/*
 * engine-columns.xlsx — G13: every column accounted for, including the ones that
 * did not land.
 *
 * Four dispositions in one file, by construction:
 *
 *   read-only      row A carries a Greenhouse URL whose id (4410982) IS the posting
 *                  key of FIXTURE_APPLICATIONS[0], so it matches by STRONG key while
 *                  disagreeing about Company, Title and URL. Those three are computed
 *                  from the posting the sweep found; an import that overwrote them
 *                  would replace measured facts with a stale copy, so they are
 *                  compared, counted and reported instead.
 *   locked         row B matches FIXTURE_APPLICATIONS[6] (Brex) by normalised
 *                  company+title, and that row's status was set by a HUMAN. A bulk
 *                  import may not overwrite it — and the value that did not land is
 *                  reported rather than dropped.
 *   unmapped       a SECOND column called "Notes". The suggester spends the first one
 *                  and leaves this one untaken, and somebody who typed into the wrong
 *                  copy deserves to be told rather than to find the sheet unchanged.
 *   unknown-column "Recruiter" — a column this app has no field for at all.
 *
 * Row C is an ordinary new row, so the report also has something to say landed.
 */
{
  const headers = ["Company", "Job Title", "Status", "URL", "Notes", "Notes", "Recruiter"];
  const rows = [
    text([
      "Stripe Payments, Inc.",
      "PM - Billing Platform",
      "Final",
      "https://boards.greenhouse.io/stripe/jobs/4410982",
      "Panel moved to Friday.",
      "ignored copy",
      "Dana Okonkwo",
    ]),
    text([
      "Brex",
      "Product Manager, Spend",
      "Offer",
      "https://boards.greenhouse.io/brex/jobs/7788991",
      "Recruiter says a decision lands this week.",
      "ignored copy",
      "Sam Ridley",
    ]),
    text([
      "Vantage Freight",
      "Product Manager, Operations",
      "Applied",
      "https://boards.greenhouse.io/vantage/jobs/9911001",
      "Applied through their own site.",
      "ignored copy",
      "",
    ]),
  ];
  await writeXlsxFile([head(headers), ...rows], { sheet: "Tracker" }).toFile(
    join(OUT, "engine-columns.xlsx"),
  );
  console.log("engine-columns.xlsx  read-only + locked + unmapped + unknown-column");
}

/*
 * big-2000.xlsx — G12: chunked, resumable, and no double-commit.
 *
 * 2,000 data rows is ten 200-row chunks, which is what makes "reload half-way
 * through and it carries on" a real journey rather than a claim. Four columns
 * rather than sixty on purpose: the point of this fixture is the row count, and a
 * 60-column version would spend the test's time in payload.
 *
 * Unique Greenhouse ids again (46xxxxx), so every row is a distinct strong key and
 * the application count afterwards is exactly 2,000 higher than before — which is
 * the assertion that a resumed commit wrote nothing twice.
 */
{
  const headers = ["Company", "Job Title", "Status", "URL"];
  const rows = [];
  for (let i = 1; i <= 2000; i += 1) {
    rows.push(
      text([
        `Bulk ${String(i).padStart(4, "0")}`,
        "Product Manager",
        i % 3 === 0 ? "Screen" : "Applied",
        `https://boards.greenhouse.io/bulk/jobs/46${String(i).padStart(5, "0")}`,
      ]),
    );
  }
  await writeXlsxFile([head(headers), ...rows], { sheet: "Applications" }).toFile(
    join(OUT, "big-2000.xlsx"),
  );
  console.log("big-2000.xlsx  2000 data rows");
}
