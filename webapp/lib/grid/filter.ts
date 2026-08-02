/**
 * The filter engine — pure, no React, applied to JobView[] BEFORE the rows
 * enter react-table (plan decision 2: the filter language never becomes table
 * state, so it stays unit-testable and the export scope can reuse it).
 *
 * Shape of a filter: an AND of OR-groups, and nothing deeper. `GridFilter` is
 * `Clause[][]` — a Clause carries no child groups, so a depth-3 filter is not
 * a validation error, it is unrepresentable. That is deliberate: spec D says
 * "max depth 2", and a rule the type system enforces cannot rot the way a
 * runtime convention does.
 *
 * Comp semantics (spec G16 + gate rule H7): comp clauses compare against the
 * TOP of the band, `compMaxK`. When that is null — nothing stated (Chime) or
 * stated but unparseable ("£85,000 - £110,000", "DOE") — the row is KEPT.
 * A posting that did not say what it pays might pay enough; hiding it because
 * of a filter about money it never mentioned is the "silent drop" G16 forbids.
 * The keep is keyed on compMaxK (what the comparison reads), not on compRange:
 * keying on the text would drop Wise's £ band, which G16 names verbatim as the
 * row that must survive. Excluding unknowns is an explicit second clause
 * (`compRange.empty.false`) the user can see as its own chip — never a side
 * effect. Numbers without a spec-granted pass (minYoe) fail on null: the gate
 * sends untagged rows to needs-info rather than guessing, and so do we.
 */
import type { JobView } from "@/lib/data/view-models";
import { decisionLabel } from "@/lib/data/view-models";

export const TEXT_FIELDS = ["company", "title", "location", "compRange"] as const;
export const ENUM_FIELDS = ["workModel", "seniority", "status", "triage"] as const;
export const NUMBER_FIELDS = ["minYoe", "compMax"] as const;
export const DATE_FIELDS = ["posted", "firstSeen"] as const;

export type TextFieldId = (typeof TEXT_FIELDS)[number];
export type EnumFieldId = (typeof ENUM_FIELDS)[number];
export type NumberFieldId = (typeof NUMBER_FIELDS)[number];
export type DateFieldId = (typeof DATE_FIELDS)[number];

export type TextClause =
  | { kind: "text"; field: TextFieldId; op: "has" | "is"; value: string }
  | { kind: "text"; field: TextFieldId; op: "empty"; value: boolean };

export type EnumClause = {
  kind: "enum";
  field: EnumFieldId;
  op: "in" | "notin";
  values: string[];
};

export type NumberClause =
  | { kind: "number"; field: NumberFieldId; op: "gte" | "lte"; value: number }
  | { kind: "number"; field: NumberFieldId; op: "between"; min: number; max: number };

export type DateClause =
  | { kind: "date"; field: DateFieldId; op: "before" | "after"; value: string }
  | { kind: "date"; field: DateFieldId; op: "inlast"; days: number };

export type RemoteClause = { kind: "remote"; value: "remote" | "onsite-hybrid" };

export type Clause = TextClause | EnumClause | NumberClause | DateClause | RemoteClause;

/** One OR-group. */
export type OrGroup = Clause[];
/** The whole filter: AND across groups. Depth 2 by construction. */
export type GridFilter = OrGroup[];

/** How each field reads to a person, in chips and in the clause builder. */
export const FIELD_LABELS: Record<string, string> = {
  company: "Company",
  title: "Title",
  location: "Location",
  compRange: "Pay",
  workModel: "Work model",
  seniority: "Seniority",
  status: "Status",
  triage: "Decision",
  minYoe: "Min years",
  compMax: "Pay",
  posted: "Posted",
  firstSeen: "First seen",
  remote: "Remote",
};

const textOf = (j: JobView, f: TextFieldId): string | null =>
  f === "company" ? j.company : f === "title" ? j.title : f === "location" ? j.location : j.compRange;

/** Triage "" surfaces as the token "undecided": an empty string cannot ride in
 *  a URL and reads as nothing in a chip. The WORD the chip shows comes from
 *  `decisionLabel`; this is the value, not the label. */
const enumOf = (j: JobView, f: EnumFieldId): string | null =>
  f === "workModel"
    ? j.workModel
    : f === "seniority"
      ? j.seniority
      : f === "status"
        ? j.status
        : j.triage === ""
          ? "undecided"
          : j.triage;

const numberOf = (j: JobView, f: NumberFieldId): number | null =>
  f === "minYoe" ? j.minYoe : j.compMaxK;

const dateOf = (j: JobView, f: DateFieldId): string | null =>
  f === "posted" ? j.posted : j.firstSeen;

/**
 * Does one clause admit one row? `now` is a parameter (ms epoch) rather than a
 * Date.now() call so the server and the hydrating client evaluate `inlast`
 * against the SAME instant — a row straddling midnight during hydration would
 * otherwise flicker in or out and trip the zero-console-error scan.
 */
export function clauseMatches(job: JobView, clause: Clause, now: number): boolean {
  switch (clause.kind) {
    case "text": {
      const v = textOf(job, clause.field);
      if (clause.op === "empty") return (!v?.trim()) === clause.value;
      if (v === null) return false;
      if (clause.op === "has")
        return clause.value === "" || v.toLowerCase().includes(clause.value.toLowerCase());
      return v.toLowerCase() === clause.value.toLowerCase();
    }
    case "enum": {
      const v = enumOf(job, clause.field);
      const hit = v !== null && clause.values.some((c) => c.toLowerCase() === v.toLowerCase());
      // null is none of the listed values: "notin Hybrid" keeps a row that
      // stated no work model at all, because it is not Hybrid.
      return clause.op === "in" ? hit : !hit;
    }
    case "number": {
      const v = numberOf(job, clause.field);
      if (v === null) return clause.field === "compMax"; // G16 — see header
      if (clause.op === "between") return v >= clause.min && v <= clause.max;
      return clause.op === "gte" ? v >= clause.value : v <= clause.value;
    }
    case "date": {
      const v = dateOf(job, clause.field);
      if (v === null) return false; // an undated row cannot satisfy a recency window
      if (clause.op === "inlast") {
        // ISO days compare lexicographically; the boundary day is inside the window.
        const cutoff = new Date(now - clause.days * 86_400_000).toISOString().slice(0, 10);
        return v >= cutoff;
      }
      return clause.op === "before" ? v < clause.value : v > clause.value;
    }
    case "remote":
      return clause.value === "remote" ? job.remote : !job.remote;
  }
}

/** AND across groups, OR within a group. The empty filter is the identity. */
export function applyFilter(rows: JobView[], filter: GridFilter, now: number): JobView[] {
  if (filter.length === 0) return rows;
  return rows.filter((job) =>
    filter.every((group) => group.length === 0 || group.some((c) => clauseMatches(job, c, now))),
  );
}

/** Case-insensitive substring over the fields a person actually scans for. */
export function quickSearch(rows: JobView[], q: string): JobView[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((j) =>
    [j.company, j.title, j.location, j.workModel, j.industry, j.roleFocus, ...j.skills]
      .filter((s): s is string => !!s)
      .some((s) => s.toLowerCase().includes(needle)),
  );
}

/** Rows a comp comparison passed only because their band is unknown — the
 *  count the chip states as "incl. N unstated" so the keep-rule is visible,
 *  not silent. */
export function compUnknownCount(rows: JobView[]): number {
  return rows.reduce((n, j) => n + (j.compMaxK === null ? 1 : 0), 0);
}

export function hasCompClause(filter: GridFilter): boolean {
  return filter.some((g) => g.some((c) => c.kind === "number" && c.field === "compMax"));
}

/**
 * Chip text. Compact and stable — e2e asserts these strings.
 *
 * PLAIN LANGUAGE, not operators. The chips used to render the comparison the way
 * the clause stores it: "Pay >= $120k", "Posted <= 7d". Mathematical glyphs are
 * the machine's notation for a rule the person stated in words, and a filter bar
 * is read at a glance by somebody checking whether the list in front of them is
 * the list they asked for. "Pay above $120k" is that sentence; the glyph is a
 * translation the reader has to do.
 */
export function formatClause(clause: Clause): string {
  const label = FIELD_LABELS[clause.kind === "remote" ? "remote" : clause.field] ?? "";
  switch (clause.kind) {
    case "text":
      if (clause.op === "empty") {
        // compRange gets the domain wording: "stated" is how the triage card
        // and the spec talk about comp, and "Comp is empty" reads like a bug.
        if (clause.field === "compRange") return clause.value ? "Pay not listed" : "Pay listed";
        return clause.value ? `${label} is empty` : `${label} is filled`;
      }
      return clause.op === "has"
        ? `${label} contains "${clause.value}"`
        : `${label} is "${clause.value}"`;
    case "enum": {
      // The DECISION field stores engine tokens (`undecided`, `snoozed`,
      // `dismissed`); the chip has to read them back in the product's words, or
      // the filter bar becomes the one surface still speaking the database's
      // vocabulary.
      const shown =
        clause.field === "triage" ? clause.values.map(decisionValueLabel) : clause.values;
      return clause.op === "in"
        ? `${label}: ${shown.join(" or ")}`
        : `${label}: not ${shown.join(", ")}`;
    }
    case "number": {
      const fmt = (n: number) => (clause.field === "compMax" ? `$${n}k` : String(n));
      // The en dash stays HERE and only here: the copy spec allows it inside a
      // numeric range, which is exactly what this is.
      if (clause.op === "between") return `${label} ${fmt(clause.min)} to ${fmt(clause.max)}`;
      return `${label} ${clause.op === "gte" ? "above" : "below"} ${fmt(clause.value)}`;
    }
    case "date":
      if (clause.op === "inlast")
        return `${label} in the last ${clause.days} ${clause.days === 1 ? "day" : "days"}`;
      return `${label} ${clause.op === "before" ? "before" : "after"} ${clause.value}`;
    case "remote":
      return clause.value === "remote" ? "Remote only" : "On-site or hybrid";
  }
}

/** A stored decision token, in the product's words. "" and "undecided" are the
 *  same state wearing two spellings — the URL cannot carry an empty one. */
function decisionValueLabel(value: string): string {
  return decisionLabel(value === "undecided" ? "" : (value as "interested"));
}

export function formatGroup(group: OrGroup): string {
  return group.map(formatClause).join(" or ");
}

/** The values the clause builder offers for an enum field: what the data
 *  actually contains, so the user picks real values instead of typing
 *  near-misses ("Remote" against rows that say "Remote (US)"). Triage is the
 *  closed set in decision order — it must be offerable even when every row is
 *  still undecided. */
export function enumValues(rows: JobView[], field: EnumFieldId): string[] {
  if (field === "triage") return ["undecided", "interested", "snoozed", "dismissed"];
  const seen = new Map<string, string>(); // lower → first-seen casing
  for (const j of rows) {
    const v = enumOf(j, field)?.trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
