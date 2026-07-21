import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Failure-mode-matrix row 20: types drift from the DB.
 *
 * lib/types.ts says "these mirror the designed tables exactly", and nothing
 * checked it — so it drifted: missing columns, and nullability inverted on
 * columns the schema declares NOT NULL. Wrong nullability is the quiet kind
 * of lie: `string | null` on a non-null column makes every consumer write a
 * fallback for a case that cannot happen, and a missing `| null` on a
 * nullable one is a crash TypeScript promised away.
 *
 * This test parses both sides — CREATE TABLE / ADD COLUMN in
 * db/migrations/*.sql, and the exported row types in lib/types.ts — and
 * fails on any column-set, nullability, or scalar-kind divergence.
 *
 * Scope: the TABLE/COLUMN shape only. The RPC-call contract (functions the
 * app calls, their parameters, their security properties) is covered by
 * tests/core/test_migrations.py — do not duplicate it here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const MIGRATIONS_DIR = path.join(REPO, "db", "migrations");
const TYPES_PATH = path.resolve(HERE, "..", "..", "lib", "types.ts");

const ALL_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

const TYPES_SRC = readFileSync(TYPES_PATH, "utf8");

/** SQL table name -> the lib/types.ts row type that mirrors it. */
const CONTRACT: Record<string, string> = {
  postings: "Posting",
  user_postings: "UserPosting",
  applications: "Application",
  channel_runs: "ChannelRun",
  users: "UserRow",
};

// ---------------------------------------------------------------- SQL side

type Kind = "string" | "number" | "boolean" | "json";

const SQL_KIND: Record<string, Kind> = {
  text: "string",
  uuid: "string",
  date: "string", // PostgREST serializes dates and timestamps as strings
  timestamptz: "string",
  bigint: "number", // int8 arrives as a JSON number through PostgREST
  integer: "number",
  numeric: "number",
  boolean: "boolean",
  jsonb: "json",
};

type Column = { notNull: boolean; kind: Kind };

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Split a CREATE TABLE body on commas outside parentheses — column defs
 * carry parens of their own (references (...), check (... in (...))). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseColumnDef(def: string): [string, Column] | null {
  // Table-level entries are constraints, not columns.
  if (/^(primary\s+key|unique|check|constraint|foreign\s+key)/i.test(def)) return null;
  const m = def.match(/^(\w+)\s+(\w+)/);
  if (!m) return null;
  const [, name, sqlType] = m;
  const kind = SQL_KIND[sqlType.toLowerCase()];
  if (!kind) throw new Error(`unmapped SQL type "${sqlType}" on column ${name} — extend SQL_KIND`);
  return [
    name,
    // PRIMARY KEY implies NOT NULL — postings.key and every identity id
    // column rely on that, with no explicit NOT NULL in the DDL.
    { notNull: /\bnot\s+null\b/i.test(def) || /\bprimary\s+key\b/i.test(def), kind },
  ];
}

function sqlTables(sql: string): Map<string, Map<string, Column>> {
  const clean = stripSqlComments(sql);
  const tables = new Map<string, Map<string, Column>>();

  for (const m of clean.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(/gi)) {
    const name = m[1];
    // Scan forward from the opening paren to its balanced close.
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "(") depth++;
      if (clean[i] === ")") depth--;
      i++;
    }
    const cols = new Map<string, Column>();
    for (const def of splitTopLevel(clean.slice(start, i - 1))) {
      const parsed = parseColumnDef(def);
      if (parsed) cols.set(parsed[0], parsed[1]);
    }
    tables.set(name, cols);
  }

  // Later migrations widen tables in place (0002 adds user_postings.created_at).
  for (const m of clean.matchAll(
    /alter\s+table\s+public\.(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)\s+([^;]+);/gi,
  )) {
    const parsed = parseColumnDef(`${m[2]} ${m[3]}`);
    if (parsed) tables.get(m[1])?.set(parsed[0], parsed[1]);
  }

  return tables;
}

// ---------------------------------------------------------------- TS side

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function tsFields(src: string, typeName: string): Map<string, { nullable: boolean; kind: Kind }> {
  const m = stripTsComments(src).match(
    new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
  );
  if (!m) throw new Error(`lib/types.ts declares no "export type ${typeName}"`);
  const fields = new Map<string, { nullable: boolean; kind: Kind }>();
  for (const f of m[1].matchAll(/^\s*(\w+):\s*([^;]+);/gm)) {
    const [, name, type] = f;
    const nullable = /\|\s*null\b/.test(type);
    const base = type.replace(/\|\s*null\b/, "").trim();
    const kind: Kind =
      base === "string" ? "string" : base === "number" ? "number" : base === "boolean" ? "boolean" : "json";
    fields.set(name, { nullable, kind });
  }
  return fields;
}

// ---------------------------------------------------------------- the contract

const TABLES = sqlTables(ALL_SQL);

it("the SQL parser found every contracted table", () => {
  // Guards the parametrized checks below from vacuously passing on a parse
  // failure — the same guard tests/core/test_migrations.py carries.
  for (const table of Object.keys(CONTRACT)) {
    expect(TABLES.has(table), `table ${table} not found in migrations`).toBe(true);
    expect(TABLES.get(table)!.size).toBeGreaterThan(0);
  }
});

describe.each(Object.entries(CONTRACT))("%s ↔ %s", (table, typeName) => {
  const sqlCols = () => TABLES.get(table)!;
  const tsCols = () => tsFields(TYPES_SRC, typeName);

  it("declares exactly the columns the table has", () => {
    const sql = [...sqlCols().keys()].sort();
    const ts = [...tsCols().keys()].sort();
    expect(ts).toEqual(sql);
  });

  it("matches the schema's nullability column-by-column", () => {
    const mismatches: string[] = [];
    for (const [name, col] of sqlCols()) {
      const field = tsCols().get(name);
      if (!field) continue; // the column-set check reports absences
      if (field.nullable === col.notNull) {
        mismatches.push(
          `${table}.${name} is ${col.notNull ? "NOT NULL" : "nullable"} in SQL ` +
            `but ${field.nullable ? "nullable" : "non-null"} in ${typeName}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches the serialized kind of every scalar column", () => {
    const mismatches: string[] = [];
    for (const [name, col] of sqlCols()) {
      const field = tsCols().get(name);
      if (!field) continue;
      if (field.kind !== col.kind) {
        mismatches.push(`${table}.${name}: SQL serializes as ${col.kind}, ${typeName} says ${field.kind}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
