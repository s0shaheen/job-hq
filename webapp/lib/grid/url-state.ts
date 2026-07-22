/**
 * URL ⇄ grid state — pure, no React. The URL is the source of truth for
 * navigational state (matrix row 19): back/forward must replay filters, and a
 * pasted link must render the same grid for whoever opens it.
 *
 * Grammar (PostgREST-flavoured, human-readable and diffable):
 *
 *   /jobs?f=workModel.in.Remote|Hybrid&f=compMax.gte.150,compRange.empty.true
 *         &q=payments&sort=posted.desc&group=company
 *
 * Each `f=` param is one AND-group; OR-clauses inside it join on ","; a clause
 * is `field.op.value`, split on the FIRST TWO dots so values keep their dots
 * ("v2.5.1"). Values escape their own "," "|" "%" (→ %2C %7C %25) so a company
 * named "Ramp, Inc." survives the separators; everything else rides plainly.
 *
 * Malformed input is dropped at CLAUSE granularity and reported in `dropped`
 * for the caller to toast — spec rule "fail loud, never guess": a clause we
 * cannot read is discarded visibly, never repaired into something the user
 * did not ask for, and never allowed to take the page down.
 */
import {
  DATE_FIELDS,
  ENUM_FIELDS,
  NUMBER_FIELDS,
  TEXT_FIELDS,
  type Clause,
  type DateFieldId,
  type EnumFieldId,
  type GridFilter,
  type NumberFieldId,
  type OrGroup,
  type TextFieldId,
} from "./filter";
import type { WorkingSet } from "./presets";
import { SORT_FIELDS, type SortField, type SortSpec } from "./sort";

export type GridUrlState = {
  set: WorkingSet;
  filter: GridFilter;
  q: string;
  sort: SortSpec | null;
  group: "company" | null;
};

export const EMPTY_GRID_STATE: GridUrlState = {
  set: "queue",
  filter: [],
  q: "",
  sort: null,
  group: null,
};

/** The params this module owns; everything else (perf=…) passes through. */
const OWNED = ["set", "f", "q", "sort", "group"];

// --- value escaping -------------------------------------------------------
// "%" first on the way in, last on the way out, or a literal "%2C" in a value
// would decay into a comma after one round trip.
const escapeValue = (v: string) =>
  v.replace(/%/g, "%25").replace(/,/g, "%2C").replace(/\|/g, "%7C");
const unescapeValue = (v: string) =>
  v.replace(/%2C/gi, ",").replace(/%7C/gi, "|").replace(/%25/gi, "%");

// --- clause ⇄ string ------------------------------------------------------

function clauseToString(c: Clause): string {
  switch (c.kind) {
    case "text":
      if (c.op === "empty") return `${c.field}.empty.${c.value}`;
      return `${c.field}.${c.op}.${escapeValue(c.value)}`;
    case "enum":
      return `${c.field}.${c.op}.${c.values.map(escapeValue).join("|")}`;
    case "number":
      if (c.op === "between") return `${c.field}.between.${c.min}-${c.max}`;
      return `${c.field}.${c.op}.${c.value}`;
    case "date":
      if (c.op === "inlast") return `${c.field}.inlast.${c.days}`;
      return `${c.field}.${c.op}.${c.value}`;
    case "remote":
      return `remote.is.${c.value}`;
  }
}

const isTextField = (f: string): f is TextFieldId => (TEXT_FIELDS as readonly string[]).includes(f);
const isEnumField = (f: string): f is EnumFieldId => (ENUM_FIELDS as readonly string[]).includes(f);
const isNumberField = (f: string): f is NumberFieldId =>
  (NUMBER_FIELDS as readonly string[]).includes(f);
const isDateField = (f: string): f is DateFieldId => (DATE_FIELDS as readonly string[]).includes(f);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const num = (s: string): number | null => {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** One clause, or null when it cannot be read. Null means DROP — a half-read
 *  clause repaired by guessing would filter on something the user never said. */
function parseClause(raw: string): Clause | null {
  const i = raw.indexOf(".");
  const j = i < 0 ? -1 : raw.indexOf(".", i + 1);
  if (i <= 0 || j < 0) return null;
  const field = raw.slice(0, i);
  const op = raw.slice(i + 1, j);
  const rawValue = raw.slice(j + 1);

  if (field === "remote") {
    if (op !== "is") return null;
    if (rawValue === "remote" || rawValue === "onsite-hybrid")
      return { kind: "remote", value: rawValue };
    return null;
  }

  if (isTextField(field)) {
    if (op === "has" || op === "is")
      return { kind: "text", field, op, value: unescapeValue(rawValue) };
    if (op === "empty") {
      if (rawValue === "true" || rawValue === "false")
        return { kind: "text", field, op, value: rawValue === "true" };
      return null;
    }
    return null;
  }

  if (isEnumField(field)) {
    if (op !== "in" && op !== "notin") return null;
    const values = rawValue.split("|").map(unescapeValue).filter((v) => v !== "");
    if (values.length === 0) return null;
    return { kind: "enum", field, op, values };
  }

  if (isNumberField(field)) {
    if (op === "gte" || op === "lte") {
      const v = num(rawValue);
      return v === null ? null : { kind: "number", field, op, value: v };
    }
    if (op === "between") {
      const dash = rawValue.indexOf("-", 1); // start at 1: a leading "-" is a sign
      if (dash < 0) return null;
      const lo = num(rawValue.slice(0, dash));
      const hi = num(rawValue.slice(dash + 1));
      if (lo === null || hi === null || lo > hi) return null;
      return { kind: "number", field, op, min: lo, max: hi };
    }
    return null;
  }

  if (isDateField(field)) {
    if (op === "before" || op === "after") {
      if (!ISO_DAY.test(rawValue)) return null;
      return { kind: "date", field, op, value: rawValue };
    }
    if (op === "inlast") {
      if (!/^\d+$/.test(rawValue)) return null;
      const days = Number(rawValue);
      if (days < 1 || days > 3650) return null;
      return { kind: "date", field, op, days };
    }
    return null;
  }

  return null;
}

// --- parse ----------------------------------------------------------------

export type ParsedGridState = { state: GridUrlState; dropped: string[] };

export function parseGridState(params: URLSearchParams): ParsedGridState {
  const dropped: string[] = [];
  const state: GridUrlState = { ...EMPTY_GRID_STATE, filter: [] };

  const rawSet = params.get("set");
  if (rawSet !== null) {
    if (rawSet === "queue" || rawSet === "all") state.set = rawSet;
    else dropped.push(`set=${rawSet}`);
  }

  for (const rawGroupParam of params.getAll("f")) {
    const group: OrGroup = [];
    for (const rawClause of rawGroupParam.split(",")) {
      const clause = parseClause(rawClause);
      if (clause) group.push(clause);
      else dropped.push(rawClause);
    }
    if (group.length > 0) state.filter.push(group);
  }

  state.q = params.get("q") ?? "";

  const rawSort = params.get("sort");
  if (rawSort !== null) {
    const dot = rawSort.lastIndexOf(".");
    const field = dot < 0 ? "" : rawSort.slice(0, dot);
    const dir = dot < 0 ? "" : rawSort.slice(dot + 1);
    if ((SORT_FIELDS as readonly string[]).includes(field) && (dir === "asc" || dir === "desc"))
      state.sort = { field: field as SortField, dir };
    else dropped.push(`sort=${rawSort}`);
  }

  const rawGroup = params.get("group");
  if (rawGroup !== null) {
    if (rawGroup === "company") state.group = "company";
    else dropped.push(`group=${rawGroup}`);
  }

  return { state, dropped };
}

// --- serialize ------------------------------------------------------------

/**
 * Minimal percent-encoding: encodeURIComponent, then give back the characters
 * that make the URL readable and are legal in a query value anyway ("," "|",
 * space as "+"). Value-level commas/pipes were pre-escaped to %2C/%7C, which
 * encodeURIComponent turns into %252C/%257C — so the give-back below can only
 * ever touch the separators, never the data.
 */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/%2C/g, ",").replace(/%7C/g, "|").replace(/%20/g, "+");

/**
 * Query string for a state (no leading "?"; "" for the default state, so the
 * bare /jobs stays the one canonical spelling of it). Params in `base` that
 * this module does not own are carried through unchanged — dropping
 * `perf=5000` on a filter change would silently swap the dataset out from
 * under the perf harness.
 */
export function serializeGridState(state: GridUrlState, base?: URLSearchParams): string {
  const parts: string[] = [];
  if (base) {
    for (const [k, v] of base.entries()) {
      if (!OWNED.includes(k)) parts.push(`${enc(k)}=${enc(v)}`);
    }
  }
  if (state.set !== "queue") parts.push(`set=${state.set}`);
  for (const group of state.filter) {
    if (group.length === 0) continue;
    parts.push(`f=${enc(group.map(clauseToString).join(","))}`);
  }
  if (state.q !== "") parts.push(`q=${enc(state.q)}`);
  if (state.sort) parts.push(`sort=${state.sort.field}.${state.sort.dir}`);
  if (state.group) parts.push(`group=${state.group}`);
  return parts.join("&");
}
