import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every column a mapper READS must be a column the query ASKED FOR.
 *
 * This file exists because that invariant broke twice on one feature, silently, and
 * nothing in any gate could see it. `companies.linkedin_id_source` (0016) was added
 * to the migration, to `app_company_row`, to `CompanyView`, to `toCompanyView`, to
 * `UniverseEntry`, to two call sites and to the fixtures — and not to `COMPANY_COLS`.
 * So `toCompanyView` read a key the select never requested, coerced `undefined` to
 * `""`, and the correction control it gates rendered nowhere against a real database.
 * In demo mode it worked perfectly.
 *
 * WHY NOTHING ELSE CATCHES IT:
 *
 *   * the fixtures set the view-model field directly, so vitest, all 44 referral e2e
 *     tests and every visual baseline are green on a column production never selects;
 *   * `tests/core/test_migrations.py` pins RPC PARAMETERS, not select lists, and
 *     `app_company_row` (the write result) did carry the field — only the read lost it;
 *   * `postgrest-js` derives its row type from the select list's literal TYPE, which
 *     is exactly the discipline the comment beside `CONNECTION_COLS` describes — and
 *     `toCompanyView(r as Record<string, unknown>)` at the call site erases it. The
 *     cast is what makes the mappers testable in isolation, and it is also what makes
 *     this class of drift invisible to `tsc`.
 *
 * So the pin replaces what the cast destroyed: parse the select lists out of the
 * source, parse each mapper's property reads out of the source, and require the
 * second to be a subset of the first.
 *
 * It is deliberately a SUBSET check, not equality. Selecting a column no mapper reads
 * is waste, not a bug, and several are read by callers rather than by the mapper
 * (`company_id` in a filter, for instance). Reading a column nobody selected is
 * always a bug, and it is always silent.
 */

const SRC = readFileSync(
  join(process.cwd(), "lib", "data", "supabase-source.ts"),
  "utf8",
);

// ---------------------------------------------------------------- the parsers

/**
 * The value of `const NAME = "…" + "…";`, joined.
 *
 * Concatenation is legal here even though the file's own comments warn against it
 * for the postgrest-js literal type: `APPLICATION_COLS` is already written that way.
 * The parser reads what is there rather than what should be.
 */
function constLiteral(name: string): string {
  const m = new RegExp(`const ${name} =\\s*([^;]+);`).exec(SRC);
  if (!m) throw new Error(`no const ${name} in supabase-source.ts — did it move?`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((s) => s[1]).join("");
}

/** The backtick select block containing `marker`, with `${COLS}` expanded. */
function templateContaining(marker: string): string {
  const start = SRC.indexOf(marker);
  if (start === -1) throw new Error(`no select containing ${marker}`);
  const open = SRC.lastIndexOf("`", start);
  const close = SRC.indexOf("`", start);
  if (open === -1 || close === -1) throw new Error(`unterminated select at ${marker}`);
  return SRC.slice(open + 1, close).replace(/\$\{(\w+)\}/g, (_, id: string) =>
    constLiteral(id),
  );
}

/**
 * A PostgREST select list -> the set of TOP-LEVEL columns it asks for.
 *
 * Embeds (`postings!inner(a, b)`) are dropped rather than flattened: their columns
 * belong to the embedded table and are pinned as their own case, against the mapper
 * variable that reads them.
 */
function selectColumns(list: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  let token = "";
  const flush = () => {
    const t = token.trim();
    // `t.includes("(")` is the embed test: by the time we flush, an embed token still
    // carries its parenthesised column list.
    if (t && !t.includes("(")) out.add(t.split(":").pop()!.trim());
    token = "";
  };
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) flush();
    else token += ch;
  }
  flush();
  return out;
}

/**
 * The plain `.select("…")` that follows `.from("<table>")`.
 *
 * Read out of the source rather than retyped: the first draft of this file hardcoded
 * the `saved_views` list from memory and got a column name wrong, which is the same
 * class of drift the file exists to catch, one layer up.
 */
function plainSelectAfterFrom(table: string): string {
  const at = SRC.indexOf(`.from("${table}")`);
  if (at === -1) throw new Error(`no .from("${table}") in supabase-source.ts`);
  const m = /\.select\(\s*"([^"]+)"/.exec(SRC.slice(at, at + 600));
  if (!m) throw new Error(`no plain .select("…") after .from("${table}")`);
  return m[1];
}

/** A named function's source, from its signature to the line that closes it. */
function functionSource(name: string): string {
  const m = new RegExp(`(export )?function ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`no function ${name} in supabase-source.ts`);
  const start = m.index;
  const end = SRC.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(start, end);
}

/**
 * Every `<variable>.<snake_case>` read in a function body.
 *
 * Deliberately naive, and safe in the naive direction: it can only ever report MORE
 * reads than exist (a false positive fails the test and a human looks), never fewer.
 * Property names in camelCase are skipped because those are the view model's own
 * output keys and JS built-ins — a database column in this schema is snake_case by
 * convention, enforced everywhere else in the repo.
 */
function readsOf(fnSrc: string, variable: string): Set<string> {
  const out = new Set<string>();
  for (const m of fnSrc.matchAll(
    new RegExp(`\\b${variable}\\.([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\\b`, "g"),
  )) {
    out.add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------- the contract

type Case = {
  /** What is being read, for the failure message. */
  table: string;
  mapper: string;
  /** The mapper parameter or local holding the row. */
  variable: string;
  /** The select list, as written in the source. */
  select: () => string;
  /**
   * Keys the mapper reads that are NOT columns of this select, each with the reason
   * it is legitimate. Every entry here is a hole in the pin, so each one is named.
   */
  notColumns?: Record<string, string>;
};

const CASES: Case[] = [
  {
    // THE case this file was written for.
    table: "companies (embedded in user_companies)",
    mapper: "toCompanyView",
    variable: "c",
    select: () => constLiteral("COMPANY_COLS"),
  },
  {
    table: "user_companies",
    mapper: "toCompanyView",
    variable: "uc",
    select: () => templateContaining("companies!inner("),
    notColumns: { companies: "the embed key, pinned as its own case above" },
  },
  {
    table: "postings (embedded in user_postings)",
    mapper: "toJobView",
    variable: "p",
    select: () => constLiteral("POSTING_COLS"),
  },
  {
    table: "user_postings",
    mapper: "toJobView",
    variable: "up",
    select: () => templateContaining("postings!inner("),
    notColumns: { postings: "the embed key, pinned as its own case above" },
  },
  {
    table: "applications",
    mapper: "toApplicationView",
    variable: "r",
    select: () => constLiteral("APPLICATION_COLS") + ", " + constLiteral("NOTE_EMBED"),
    notColumns: {
      postings: "an embed the pipeline read adds inline, not part of APPLICATION_COLS",
      application_notes: "the note embed's key; its columns are NOTE_EMBED's",
      latest_note:
        "jsonb from app_set_status/app_add_note, never a column — the mapper reads " +
        "both shapes on purpose so one function serves the RPC result and the select",
      note_count: "same jsonb-only shape as latest_note; the embed's length is the fallback",
      posting_status:
        "supplied by migration 0010's row builder alongside note_count/latest_note; " +
        "the select's own `postings` embed is what provides it on a plain read",
    },
  },
  {
    table: "connections",
    mapper: "toConnectionView",
    variable: "r",
    select: () => constLiteral("CONNECTION_COLS"),
  },
  {
    // 0020: the RPC results go through the same mapper, so `apify_run_ids`/`results`/
    // `params` must be selected even though only the poll route reads the run ids.
    table: "warm_searches",
    mapper: "toWarmSearchView",
    variable: "r",
    select: () => constLiteral("WARM_SEARCH_COLS"),
  },
  {
    table: "warm_pins",
    mapper: "toWarmPinView",
    variable: "r",
    select: () => constLiteral("WARM_PIN_COLS"),
  },
  {
    table: "channel_runs",
    mapper: "toHealthView",
    variable: "r",
    select: () => constLiteral("CHANNEL_RUN_COLS"),
  },
  {
    table: "import_batches",
    mapper: "toImportBatchView",
    variable: "r",
    select: () => constLiteral("IMPORT_BATCH_COLS"),
    notColumns: {
      staged_count:
        "exists only in the jsonb app_import_batch_row returns — a plain select " +
        "cannot count another table, which the constant's own comment says",
    },
  },
  {
    table: "import_rows",
    mapper: "toImportRowView",
    variable: "r",
    select: () => constLiteral("IMPORT_ROW_COLS"),
  },
  {
    table: "saved_views",
    mapper: "toSavedView",
    variable: "r",
    select: () => plainSelectAfterFrom("saved_views"),
  },
  {
    // 0025's five knobs plus their own version token. The one that would bite
    // silently here is `display_updated_at`: `profiles` carries TWO tokens and
    // selecting the Search Profile's `updated_at` by mistake would send it back
    // as the preferences' expectation, so every autosave after a profile save
    // would be refused as somebody else's edit — with nothing on screen and no
    // type error anywhere.
    table: "profiles (the display half)",
    mapper: "toDisplayPrefsView",
    variable: "r",
    select: () => constLiteral("DISPLAY_PREFS_COLS"),
  },
];

describe("every column a mapper reads is a column the query selects", () => {
  it("the parsers actually found something", () => {
    // Guards every case below from passing vacuously on a parse failure — the same
    // guard tests/core/test_migrations.py carries for its SQL parser.
    expect(selectColumns(constLiteral("COMPANY_COLS")).size).toBeGreaterThan(5);
    expect(readsOf(functionSource("toCompanyView"), "c").size).toBeGreaterThan(5);
    expect(functionSource("toJobView")).toContain("parseCompRange");
  });

  it.each(CASES.map((c) => [`${c.mapper} reads ${c.table}`, c] as const))(
    "%s",
    (_label, c) => {
      const selected = selectColumns(c.select());
      const allowed = new Set([...selected, ...Object.keys(c.notColumns ?? {})]);
      const missing = [...readsOf(functionSource(c.mapper), c.variable)]
        .filter((k) => !allowed.has(k))
        .sort();
      expect(missing, `${c.mapper} reads ${c.variable}.{${missing}} — not selected`).toEqual(
        [],
      );
    },
  );

  it("every select list in the file is pinned by a case above", () => {
    // Without this the pin is opt-in, and the next select list added without an entry
    // is exactly as unguarded as COMPANY_COLS was. A new `*_COLS` constant must either
    // be pinned or be deliberately listed as unread.
    const declared = [...SRC.matchAll(/const (\w+_COLS) =/g)].map((m) => m[1]).sort();
    const pinned = new Set(
      CASES.flatMap((c) => [...(c.select().length ? [c.select()] : [])]),
    );
    const unpinned = declared.filter(
      (name) => ![...pinned].some((sel) => sel.includes(constLiteral(name).split(",")[0])),
    );
    expect(unpinned, `select lists no mapper case covers: ${unpinned}`).toEqual([]);
  });
});

describe("the column that started this", () => {
  it("COMPANY_COLS asks for linkedin_id_source", () => {
    // MUTATION REASON: remove it and the generic case above goes red too — this one is
    // here so the failure NAMES the field, because the symptom in production is a
    // correction control that renders nowhere and no error anywhere.
    expect(selectColumns(constLiteral("COMPANY_COLS"))).toContain("linkedin_id_source");
  });

  it("selects both halves of the id: the value and who wrote it", () => {
    // They are one fact. A read that carries the id without its provenance cannot tell
    // "a person chose this" from "the sweep guessed it", which is the entire question
    // the control exists to let somebody answer.
    const cols = selectColumns(constLiteral("COMPANY_COLS"));
    expect(cols).toContain("linkedin_company_id");
    expect(cols).toContain("linkedin_id_source");
  });
});
