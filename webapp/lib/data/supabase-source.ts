import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AppWriteResult,
  CommitImportInput,
  CreateImportInput,
  ImportBatchResult,
  ImportCommitResult,
  ImportPreviewResult,
  ImportUndoResult,
  IncludeImportRowsInput,
  DiscardImportInput,
  DiscardImportResult,
  ResolveImportRowInput,
  ResolveImportRowResult,
  SetImportMappingInput,
  StageImportInput,
  StageImportResult,
  UndoImportInput,
  BulkReviewInput,
  BulkReviewResult,
  BulkTriageInput,
  BulkWriteResult,
  CompanyFlagsInput,
  CompanyFlagsResult,
  DataSource,
  DeleteViewInput,
  DeleteViewResult,
  NextActionInput,
  NoteInput,
  ProposeCompaniesInput,
  ProposeCompaniesResult,
  QueueOptions,
  SaveViewInput,
  SaveViewResult,
  StatusInput,
  SuggestionInput,
  TriageInput,
  WriteResult,
  ProfileView,
  PreviewProfileInput,
  PreviewProfileResult,
  CommitProfileInput,
  CommitProfileResult,
  DisplayPrefsView,
  SetDisplayPrefsInput,
  SetDisplayPrefsResult,
  ClearConnectionsInput,
  ClearConnectionsResult,
  ImportConnectionsInput,
  ImportConnectionsResult,
  LinkedinCompanyIdInput,
  AnswerWriteResult,
  DeleteAnswerInput,
  DeleteAnswerResult,
  DeletePolicyResult,
  DeletePolicyRuleInput,
  PolicyWriteResult,
  SetPolicyRuleInput,
  UpsertAnswerInput,
  StartWarmSearchInput,
  StartWarmSearchResult,
  AttachWarmRunInput,
  CompleteWarmSearchInput,
  FailWarmSearchInput,
  WarmSearchByIdResult,
  WarmSearchView,
  WarmPinView,
  PinWarmIntroInput,
  PinWarmIntroResult,
  UnpinWarmIntroInput,
  UnpinWarmIntroResult,
  WarmVendorRun,
} from "./source";
import { APPLY_LIBRARY_LIMIT, CONNECTION_LIST_LIMIT, IMPORT_LIST_LIMIT } from "./source";
import { warmDailyCap, WARM_CAP_SQLSTATE, warmOverCapMessage } from "@/lib/warm/config";
import { WARM_PERSONAS } from "@/lib/warm/types";
import type {
  WarmCandidate,
  WarmFit,
  WarmParams,
  WarmPersona,
  WarmSignal,
  WarmStatus,
} from "@/lib/warm/types";
import { questionKey } from "@/lib/apply/normalize";
import {
  toAnswerView,
  toPolicyRuleView,
  type AnswerView,
  type PolicyRuleView,
} from "@/lib/apply/views";
import { companyNameKey } from "./view-models";
import { parseComp } from "@/lib/gating/comp";
import { clampWindowDays, computePreview, type PreviewPosting } from "@/lib/profile/preview";
import { isOnboarded, parseCriteria } from "@/lib/profile/criteria";
import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs } from "@/lib/display/prefs";
import type {
  ApplicationView,
  ChannelHealthView,
  CompanyView,
  ConnectionView,
  Disposition,
  JobView,
  NoteView,
  ReliabilityTier,
  ReviewState,
  SavedView,
  Triage,
} from "./view-models";
import {
  EMPTY_IMPORT_MAPPING,
  type ImportBatchView,
  type ImportColumnReportView,
  type ImportCounts,
  type ImportMapping,
  type ImportRowView,
} from "@/lib/import/views";

/** One saved_views row, mapped for the grid. `state` is passed through as-is. */
function toSavedView(r: Record<string, unknown>): SavedView {
  return {
    id: String(r.id ?? ""),
    surface: String(r.surface ?? "jobs"),
    name: String(r.name ?? ""),
    state: r.state ?? {},
    isDefault: bool(r.is_default),
    updatedAt: str(r.updated_at),
  };
}

/**
 * The display half of one `profiles` row (0025) — from a select OR from
 * `app_display_prefs_row`'s jsonb, which is built with the same keys so that
 * one mapper serves the read and the write.
 *
 * The five values are handed to `parseDisplayPrefs` one by one rather than as
 * the whole row, and that is not ceremony: `tests/unit/supabase-select-lists.test.ts`
 * pins every column a MAPPER reads against the columns its query ASKED FOR, and
 * it reads this function's source to do it. Passing `r` straight through would
 * move all five reads inside `lib/display/prefs.ts`, where the pin cannot see
 * them — which is exactly how `companies.linkedin_id_source` went missing from
 * `COMPANY_COLS` and rendered nothing against a real database while demo mode
 * worked perfectly.
 */
export function toDisplayPrefsView(raw: unknown): DisplayPrefsView {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...parseDisplayPrefs({
      display_density: r.display_density,
      display_type_scale: r.display_type_scale,
      display_keyboard_hints: r.display_keyboard_hints,
      display_landing_view: r.display_landing_view,
      display_theme: r.display_theme,
    }),
    updatedAt: str(r.display_updated_at),
  };
}

const POSTING_COLS =
  "key, company, title, location, url, posted, first_seen, last_seen, status, tags, geo, source";
const CHANNEL_RUN_COLS = "channel, ran_at, fetched, new_rows, filtered, tagged, errors";
/**
 * The note embed on a pipeline read, and its bound.
 *
 * The view model uses exactly two things from this: `noteCount` and the NEWEST
 * note. The embed nevertheless pulled every note on every row of every render and
 * every export — one long-running application with a hundred notes multiplied the
 * payload for a panel nobody had opened, while `notes()` (the panel's own read)
 * has always been capped at 200.
 *
 * `count` cannot be selected alongside rows in one PostgREST embed, so the honest
 * bound is a small window: enough to hold the newest note reliably, small enough
 * that the payload cannot grow with a row's history. The disclosed consequence is
 * that `noteCount` saturates — said in `toApplicationView`, where the number is
 * built, rather than left for a reader to discover.
 */
const NOTE_EMBED_LIMIT = 5;
const NOTE_EMBED = "application_notes(id, body, author, created_at)";

const APPLICATION_COLS =
  "id, posting_key, company, title, url, status, status_actor, suggested_status, " +
  "evidence, applied_date, next_action, next_action_date, notes, updated_at";
const COMPANY_COLS =
  "id, name, ats, slug, source, reliability_tier, resolution_method, linkedin_company_id, linkedin_id_source, updated_at";

/**
 * One string literal, for COMPANY_COLS' reason: `postgrest-js` parses the select
 * list out of the literal TYPE, and a concatenation widens it to `string`.
 */
const CONNECTION_COLS = "id, full_name, company, company_key, title, profile_url, connected_on";

/**
 * The warm-intro reads. One string literal each (COMPANY_COLS' reason). The RPC
 * results go through the SAME mappers, so `apify_run_ids`/`results`/`params` are
 * selected even though only the poll route reads the run ids — a mapper that read
 * a column the select never asked for would coerce `undefined` silently, which is
 * exactly what `supabase-select-lists.test.ts` exists to catch.
 */
const WARM_SEARCH_COLS =
  "id, target_kind, posting_key, company, params, overlays, status, vendor_runs, results, error, created_at, updated_at";
const WARM_PIN_COLS =
  "id, target_kind, posting_key, company, company_key, full_name, profile_url, headline, source, updated_at";

/** SQLSTATE `app_*_warm_search` raises for "not this user's search" — a 404. */
const NO_SUCH_WARM_SEARCH = "P0002";

/**
 * The display half of `profiles` (0025). One string literal, same reason.
 *
 * `display_updated_at` and not `updated_at`: they are two independent version
 * tokens on one row, and selecting the wrong one here would send the Search
 * Profile's token as the preferences' expectation — so every autosave after a
 * profile save would be reported as somebody else's edit.
 */
const DISPLAY_PREFS_COLS =
  "display_density, display_type_scale, display_keyboard_hints, display_landing_view, display_theme, display_updated_at";

// ---- import row shapes (P9) -------------------------------------------------

// One string literal each, not a concatenation. `postgrest-js` parses the select
// list out of the literal TYPE to shape its result, and a `"a" + "b"` widens to
// `string`, at which point every row comes back as `GenericStringError` and the
// mapper below needs a cast through `unknown` to compile. The cast would work and
// it would also be the point where a renamed column stops being a type error.
const IMPORT_BATCH_COLS =
  "id, state, filename, source_kind, content_hash, row_count, committed_count, mapping, created_at, updated_at, committed_at, undo_expires_at";

const IMPORT_ROW_COLS =
  "row_number, raw, mapped, job_key, key_strength, match_kind, matched_application_id, conflict_state, conflict, choices, included, outcome, notice, error";

/**
 * A batch row (from a select) or the jsonb `app_import_batch_row` returns.
 *
 * Both shapes on purpose: the RPCs return the jsonb and the landing list selects
 * columns, and they carry the same keys precisely so this function is the only
 * reader either needs. `staged_count` exists only in the jsonb — a plain select
 * cannot count another table — so it falls back to `row_count`, which is what
 * the batch itself declared.
 */
function toImportBatchView(r: Record<string, unknown>): ImportBatchView {
  const mapping = (r.mapping ?? {}) as Partial<ImportMapping>;
  return {
    id: String(r.id ?? ""),
    state: String(r.state ?? "uploaded") as ImportBatchView["state"],
    filename: String(r.filename ?? ""),
    sourceKind: String(r.source_kind ?? "csv") as ImportBatchView["sourceKind"],
    contentHash: String(r.content_hash ?? ""),
    rowCount: Number(r.row_count ?? 0),
    committedCount: Number(r.committed_count ?? 0),
    stagedCount: Number(r.staged_count ?? r.row_count ?? 0),
    mapping: {
      ...EMPTY_IMPORT_MAPPING,
      ...mapping,
      headers: Array.isArray(mapping.headers) ? mapping.headers.map(String) : [],
      unmapped: Array.isArray(mapping.unmapped) ? mapping.unmapped : [],
    },
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    committedAt: str(r.committed_at),
    undoExpiresAt: str(r.undo_expires_at),
  };
}

/** Every cell as a string — a spreadsheet cell is text by the time we show it. */
function cells(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    // A blank cell stays absent rather than becoming "", because "the file did
    // not say" and "the file said nothing" are the same claim and both must read
    // as absent everywhere downstream.
    if (val === null || val === undefined) continue;
    out[k] = String(val);
  }
  return out;
}

function toImportRowView(r: Record<string, unknown>): ImportRowView {
  const conflict: Record<string, { mine: string; theirs: string }> = {};
  for (const [col, pair] of Object.entries((r.conflict ?? {}) as Record<string, unknown>)) {
    const p = (pair ?? {}) as { mine?: unknown; theirs?: unknown };
    conflict[col] = { mine: String(p.mine ?? ""), theirs: String(p.theirs ?? "") };
  }
  return {
    rowNumber: Number(r.row_number ?? 0),
    raw: cells(r.raw),
    mapped: cells(r.mapped),
    jobKey: String(r.job_key ?? ""),
    keyStrength: String(r.key_strength ?? "none") as ImportRowView["keyStrength"],
    matchKind: String(r.match_kind ?? "new") as ImportRowView["matchKind"],
    matchedApplicationId: num(r.matched_application_id),
    conflictState: String(r.conflict_state ?? "none") as ImportRowView["conflictState"],
    conflict,
    choices: (r.choices ?? {}) as Record<string, "mine" | "theirs">,
    included: bool(r.included),
    outcome: String(r.outcome ?? "pending") as ImportRowView["outcome"],
    notice: String(r.notice ?? ""),
    error: String(r.error ?? ""),
  };
}


/** jsonb fields arrive untyped; coerce narrowly and never guess a value. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? null : s;
}
function bool(v: unknown): boolean {
  return v === true || v === "TRUE" || v === "true" || v === 1;
}

/**
 * comp_range -> [min_k, max_k] in thousands of dollars, for the grid's two
 * numeric columns.
 *
 * The parse itself is `lib/gating/comp.ts` — the port of `monitor/comp.py`,
 * and per plans/README C7 the ONE comp parser in this app. It used to be
 * written out a second time here, which is the shape that produces a filter
 * and a preview quietly disagreeing about which postings clear a floor.
 *
 * What stays here is one deliberate DEPARTURE from the engine: a band in a
 * non-dollar currency is null. The export column header says "$k", and £85k
 * written under it as if it were dollars is a lie — `monitor/comp.py` can
 * afford to be looser because it only ever judges a floor, and the gate must
 * keep matching it exactly (the corpus asserts that). The fixture's Wise row
 * (£85,000–£110,000 → null) pins this half.
 */
const NON_DOLLAR = /[£€¥₹]|\b(GBP|EUR|CAD|AUD|CHF|JPY|INR|SGD)\b/;

function parseCompRange(text: string | null): [number | null, number | null] {
  if (text && NON_DOLLAR.test(text)) return [null, null];
  return parseComp(text);
}

export function toJobView(up: Record<string, unknown>): JobView | null {
  const p = (Array.isArray(up.postings) ? up.postings[0] : up.postings) as
    | Record<string, unknown>
    | undefined;
  if (!p) return null;
  const tags = (p.tags ?? {}) as Record<string, unknown>;
  const geo = (p.geo ?? {}) as Record<string, unknown>;
  const skills = str(tags.skills);
  const [compMinK, compMaxK] = parseCompRange(str(tags.comp_range));

  return {
    key: String(p.key ?? ""),
    company: String(p.company ?? ""),
    title: String(p.title ?? ""),
    url: String(p.url ?? ""),
    location: str(p.location),
    metro: str(geo.metro),
    market: str(geo.market),
    country: str(geo.country),
    remote: bool(geo.remote),
    workModel: str(tags.work_model),
    compRange: str(tags.comp_range),
    compMinK,
    compMaxK,
    minYoe: num(tags.min_yoe),
    seniority: str(tags.seniority),
    industry: str(tags.company_industry),
    roleFocus: str(tags.role_focus),
    skills: skills ? skills.split(";").map((s) => s.trim()).filter(Boolean) : [],
    posted: str(p.posted),
    firstSeen: str(p.first_seen),
    taggedAt: str(tags.tagged_at),
    status: str(p.status),
    disposition: (String(up.disposition ?? "needs-info") as Disposition),
    dispositionReason: String(up.disposition_reason ?? ""),
    triage: (String(up.triage ?? "") as Triage),
    snoozeUntil: str(up.snooze_until),
    updatedAt: str(up.updated_at),
  };
}

/**
 * One user_companies row (with its nested company) → CompanyView.
 *
 * The tier is coerced through the same CHECK the database enforces
 * (`null | 1 | 2 | 3`), rather than trusted: `reliability_tier` is a smallint, and
 * a value outside that set could only come from a schema drift or a direct write
 * that bypassed the constraint. Reading it as "unresolved" is the honest answer —
 * inventing a tier from a number the design does not define is exactly the
 * false-confidence the provenance vocabulary exists to prevent.
 *
 * `review_state` gets the same treatment for the same reason, defaulting to
 * "proposed": an unrecognised state must land in the pile that awaits a human,
 * never in the approved set that feeds the sweep.
 */
export function toCompanyView(uc: Record<string, unknown>): CompanyView | null {
  const c = (Array.isArray(uc.companies) ? uc.companies[0] : uc.companies) as
    | Record<string, unknown>
    | undefined;
  if (!c) return null;
  const id = Number(c.id ?? uc.company_id ?? 0);
  if (!Number.isFinite(id) || id === 0) return null;

  const rawTier = num(c.reliability_tier);
  const tier: ReliabilityTier =
    rawTier === 1 || rawTier === 2 || rawTier === 3 ? rawTier : null;

  const rawState = String(uc.review_state ?? "").trim();
  const reviewState: ReviewState =
    rawState === "approved" || rawState === "dismissed" || rawState === "proposed"
      ? rawState
      : "proposed";

  return {
    key: String(id),
    id,
    name: String(c.name ?? ""),
    ats: String(c.ats ?? ""),
    slug: String(c.slug ?? ""),
    source: String(c.source ?? ""),
    tier,
    resolutionMethod: String(c.resolution_method ?? ""),
    reviewState,
    enabled: bool(uc.monitor),
    priority: bool(uc.priority),
    seeded: bool(uc.seeded),
    linkedinCompanyId: String(c.linkedin_company_id ?? ""),
    linkedinIdSource: String(c.linkedin_id_source ?? ""),
    updatedAt: str(uc.updated_at),
    // The SHARED row's token, out of the nested object. Two tokens, two writes;
    // `app_company_row` puts this one inside `companies` precisely so a caller
    // cannot pick it up by accident.
    companyUpdatedAt: str(c.updated_at),
  };
}

/**
 * One connection row. `company_key` comes from the GENERATED column, never
 * recomputed here — that is the whole reason it is generated.
 */
export function toConnectionView(r: Record<string, unknown>): ConnectionView {
  return {
    id: Number(r.id ?? 0),
    fullName: String(r.full_name ?? ""),
    company: String(r.company ?? ""),
    companyKey: String(r.company_key ?? ""),
    title: String(r.title ?? ""),
    profileUrl: String(r.profile_url ?? ""),
    connectedOn: str(r.connected_on),
  };
}

// ---- the warm-intro finder (0020) ------------------------------------------

function warmParams(v: unknown): WarmParams {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    role: String(o.role ?? ""),
    senior: String(o.senior ?? ""),
    recruiter: String(o.recruiter ?? ""),
  };
}

function warmStatus(v: unknown): WarmStatus {
  return v === "done" || v === "cancelled" || v === "failed" ? v : "running";
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function warmOverlays(v: unknown): { schools: string[]; pastCompanies: string[] } {
  const o = (v ?? {}) as Record<string, unknown>;
  return { schools: stringArray(o.schools), pastCompanies: stringArray(o.pastCompanies) };
}

/** The persisted [{run_id, persona}] → [{runId, persona}], persona narrowed. */
function warmVendorRuns(v: unknown): WarmVendorRun[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => (r ?? {}) as Record<string, unknown>)
    .filter((r) => typeof r.run_id === "string" && WARM_PERSONAS.includes(r.persona as WarmPersona))
    .map((r) => ({ runId: String(r.run_id), persona: r.persona as WarmPersona }));
}

function warmFit(v: unknown): WarmFit | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const tier = o.tier === "strong" || o.tier === "medium" || o.tier === "weak" ? o.tier : undefined;
  if (!tier) return undefined;
  return { tier, reason: String(o.reason ?? "") };
}

/**
 * The stored `results` jsonb → `WarmCandidate[]`. Written camelCase by
 * `completeWarmSearch` (the ranked list is stored verbatim), read camelCase here,
 * every field defensive because it crossed a jsonb boundary the compiler cannot see.
 */
function warmCandidates(v: unknown): WarmCandidate[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const signals = Array.isArray(o.signals)
      ? o.signals
          .map((s) => (s ?? {}) as Record<string, unknown>)
          .map((s) => {
            const kind =
              s.kind === "school" ? "school" : s.kind === "past_company" ? "past_company" : "persona";
            return { kind: kind as WarmSignal["kind"], label: String(s.label ?? "") };
          })
      : [];
    return {
      fullName: String(o.fullName ?? ""),
      headline: String(o.headline ?? ""),
      company: String(o.company ?? ""),
      location: String(o.location ?? ""),
      years: String(o.years ?? ""),
      linkedinUrl: String(o.linkedinUrl ?? ""),
      isRecruiter: Boolean(o.isRecruiter),
      signals,
      score: Number(o.score ?? 0),
      ...(warmFit(o.fit) ? { fit: warmFit(o.fit) } : {}),
    };
  });
}

export function toWarmSearchView(r: Record<string, unknown>): WarmSearchView {
  return {
    id: String(r.id ?? ""),
    targetKind: r.target_kind === "company" ? "company" : "posting",
    postingKey: String(r.posting_key ?? ""),
    company: String(r.company ?? ""),
    params: warmParams(r.params),
    overlays: warmOverlays(r.overlays),
    status: warmStatus(r.status),
    results: warmCandidates(r.results),
    error: String(r.error ?? ""),
    runs: warmVendorRuns(r.vendor_runs),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function toWarmPinView(r: Record<string, unknown>): WarmPinView {
  return {
    id: Number(r.id ?? 0),
    targetKind: r.target_kind === "company" ? "company" : "posting",
    postingKey: String(r.posting_key ?? ""),
    company: String(r.company ?? ""),
    companyKey: String(r.company_key ?? ""),
    fullName: String(r.full_name ?? ""),
    profileUrl: String(r.profile_url ?? ""),
    headline: String(r.headline ?? ""),
    source: String(r.source ?? "warm"),
    updatedAt: str(r.updated_at),
  };
}

export function toNoteView(r: Record<string, unknown>): NoteView {
  return {
    id: Number(r.id ?? 0),
    body: String(r.body ?? ""),
    author: String(r.author ?? "user"),
    createdAt: str(r.created_at),
  };
}

/**
 * One `applications` row → ApplicationView.
 *
 * Two shapes arrive here and both must work: a PostgREST select with embeds
 * (`postings`, `application_notes`), and the flat jsonb `app_application_row`
 * builds inside migration 0010 — which supplies `posting_status`, `note_count`
 * and `latest_note` directly rather than as embeds. Handling both in one mapper
 * is what stops a write's returned row from rendering differently to the same
 * row re-read a moment later.
 *
 * `status_actor` is coerced through the CHECK the database enforces rather than
 * trusted, and an unrecognised value reads as `"system"`. That direction is
 * deliberate: `"user"` is a claim that a person decided something, and inventing
 * it from a value the design does not define would lock a row nobody claimed —
 * with no UI in this phase to unlock it.
 */
export function toApplicationView(r: Record<string, unknown>): ApplicationView {
  const posting = (Array.isArray(r.postings) ? r.postings[0] : r.postings) as
    | Record<string, unknown>
    | undefined;
  const embedded = Array.isArray(r.application_notes)
    ? (r.application_notes as Record<string, unknown>[])
    : [];
  const latestFromFn = (r.latest_note ?? null) as Record<string, unknown> | null;

  const notes = embedded.map(toNoteView);
  const latestNote = notes.length
    ? notes[0]
    : latestFromFn
      ? toNoteView(latestFromFn)
      : null;
  // `note_count` when the function supplied it, the embed's length otherwise.
  // Not `embedded.length || num(...)`: a genuine zero would fall through to the
  // other branch, which is the class of bug `??` exists to prevent.
  //
  // The function's count is EXACT. The embed's is capped at `NOTE_EMBED_LIMIT`,
  // because that read is windowed rather than unbounded — so a row with more notes
  // reads as exactly the cap until a write returns the real number. The
  // alternative was pulling every note on every row of every render to make a
  // badge one higher, which is the trade this loses on purpose.
  const noteCount = embedded.length
    ? embedded.length
    : (num(r.note_count) ?? (latestNote ? 1 : 0));

  const actor = String(r.status_actor ?? "system").trim();

  return {
    id: Number(r.id ?? 0),
    postingKey: str(r.posting_key),
    company: String(r.company ?? ""),
    title: String(r.title ?? ""),
    url: str(r.url),
    status: String(r.status ?? "Inbox"),
    statusActor: actor === "user" ? "user" : "system",
    suggestedStatus: str(r.suggested_status),
    evidence: str(r.evidence),
    appliedDate: str(r.applied_date),
    nextAction: str(r.next_action),
    nextActionDate: str(r.next_action_date),
    notes: str(r.notes),
    noteCount,
    latestNote,
    postingStatus: posting ? str(posting.status) : str(r.posting_status),
    updatedAt: str(r.updated_at),
  };
}

export class SupabaseDataSource implements DataSource {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
  ) {}

  private async userPostings(filter: (q: any) => any): Promise<JobView[]> {
    let q = this.supabase
      .from("user_postings")
      .select(
        `posting_key, disposition, disposition_reason, triage, snooze_until, updated_at,
         postings!inner(${POSTING_COLS})`,
      )
      .eq("user_id", this.userId);
    q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? [])
      .map((r) => toJobView(r as Record<string, unknown>))
      .filter((j): j is JobView => j !== null);
  }

  queue(opts: QueueOptions = {}): Promise<JobView[]> {
    return this.userPostings((q) =>
      q
        .eq("disposition", "qualified")
        .eq("triage", "")
        .neq("postings.status", "Closed")
        // "Freshest first" means first_seen — the column JobView carries and
        // the fixture sorts by. This ordered by last_seen, which every sweep
        // bumps on a posting it still sees, so the queue reshuffled twice a
        // day and demo order never matched production. The key tiebreak
        // exists because Postgres returns tied rows in whatever order the
        // plan produced — nondeterminism the stable demo could not show.
        .order("postings(first_seen)", { ascending: false, nullsFirst: false })
        .order("posting_key", { ascending: false })
        .limit(opts.limit ?? 20),
    );
  }

  jobs(): Promise<JobView[]> {
    // Same order as queue(): the 5000 cap means the ordering decides WHICH
    // rows survive it, so it cannot be left undefined on a tie either.
    return this.userPostings((q) =>
      q
        .order("postings(first_seen)", { ascending: false, nullsFirst: false })
        .order("posting_key", { ascending: false })
        .limit(5000),
    );
  }

  async applications(): Promise<ApplicationView[]> {
    const { data, error } = await this.supabase
      .from("applications")
      .select(
        `${APPLICATION_COLS},
         postings(status),
         ${NOTE_EMBED}`,
      )
      .eq("user_id", this.userId)
      // Newest note first, and `id` behind it: two notes written in the same
      // millisecond would otherwise be ordered by whatever the plan produced,
      // and `latestNote` would flip between them across reads.
      .order("created_at", { referencedTable: "application_notes", ascending: false })
      .order("id", { referencedTable: "application_notes", ascending: false })
      .limit(NOTE_EMBED_LIMIT, { referencedTable: "application_notes" })
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => toApplicationView(r as Record<string, unknown>));
  }

  /**
   * One application's note history, newest first.
   *
   * A separate read rather than a second use of the embed above: the dialog is
   * opened on one row, and paying for every row's full history on every pipeline
   * load to serve a panel nobody has opened yet is the wrong trade. RLS scopes
   * it — the `user_id` filter is here for the query plan, not for safety.
   */
  async notes(applicationId: number): Promise<NoteView[]> {
    const { data, error } = await this.supabase
      .from("application_notes")
      .select("id, body, author, created_at")
      .eq("user_id", this.userId)
      .eq("application_id", applicationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => toNoteView(r as Record<string, unknown>));
  }

  /**
   * Every pipeline write goes through the same shape, so it is written once.
   *
   * The re-read on a conflict is what makes matrix row 46 possible: a toast
   * alone leaves the stale value on screen, and the UI needs the SERVER's row to
   * render instead of the one it optimistically wrote.
   */
  private async appWrite(
    fn: string,
    args: Record<string, unknown>,
    applicationId: number,
  ): Promise<AppWriteResult> {
    const { data, error } = await this.supabase.rpc(fn, args);
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        const fresh = await this.oneApplication(applicationId);
        if (fresh) return { ok: false, kind: "conflict", current: fresh };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const row = data as Record<string, unknown> | null;
    if (!row || row.id === undefined || row.id === null) {
      const fresh = await this.oneApplication(applicationId);
      if (fresh) return { ok: true, application: fresh };
      return {
        ok: false,
        kind: "error",
        message: "Write succeeded but the row could not be re-read",
      };
    }
    return { ok: true, application: toApplicationView(row) };
  }

  private async oneApplication(applicationId: number): Promise<ApplicationView | null> {
    const { data, error } = await this.supabase
      .from("applications")
      .select(
        `${APPLICATION_COLS},
         postings(status),
         ${NOTE_EMBED}`,
      )
      .eq("user_id", this.userId)
      .eq("id", applicationId)
      .order("created_at", { referencedTable: "application_notes", ascending: false })
      .order("id", { referencedTable: "application_notes", ascending: false })
      .limit(NOTE_EMBED_LIMIT, { referencedTable: "application_notes" })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    return row ? toApplicationView(row) : null;
  }

  setStatus(input: StatusInput): Promise<AppWriteResult> {
    return this.appWrite(
      "app_set_status",
      {
        p_application_id: input.applicationId,
        p_status: input.status,
        p_note: input.note ?? null,
        p_idem: input.idempotencyKey,
        p_expected_updated_at: input.expectedUpdatedAt,
      },
      input.applicationId,
    );
  }

  resolveSuggestion(input: SuggestionInput): Promise<AppWriteResult> {
    return this.appWrite(
      "app_resolve_suggestion",
      {
        p_application_id: input.applicationId,
        p_decision: input.decision,
        p_idem: input.idempotencyKey,
        p_expected_updated_at: input.expectedUpdatedAt,
      },
      input.applicationId,
    );
  }

  addNote(input: NoteInput): Promise<AppWriteResult> {
    return this.appWrite(
      "app_add_note",
      {
        p_application_id: input.applicationId,
        p_body: input.body,
        p_idem: input.idempotencyKey,
      },
      input.applicationId,
    );
  }

  setNextAction(input: NextActionInput): Promise<AppWriteResult> {
    return this.appWrite(
      "app_set_next_action",
      {
        p_application_id: input.applicationId,
        p_next_action: input.nextAction,
        p_next_action_date: input.nextActionDate,
        p_idem: input.idempotencyKey,
        p_expected_updated_at: input.expectedUpdatedAt,
      },
      input.applicationId,
    );
  }

  async health(): Promise<ChannelHealthView[]> {
    const { data, error } = await this.supabase
      .from("channel_runs")
      .select(CHANNEL_RUN_COLS)
      .order("ran_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const latest = new Map<string, ChannelHealthView>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const channel = String(r.channel ?? "");
      if (latest.has(channel)) continue; // ordered desc: first is newest
      latest.set(channel, toHealthView(channel, r));
    }

    // At real cadences the 200 newest rows span ~5.5 days, so a channel dead
    // longer than that had scrolled out of the window and vanished from
    // /health entirely — the page whose whole job is "is the machinery alive"
    // answered "fine" by omission. Every expected channel missing from the
    // window gets a targeted latest-row lookup, and one that has never run at
    // all still appears, as never-ran (ranAt null renders "never" + stale;
    // digest.py reports the same state as "no heartbeat yet").
    const missing = Object.keys(CADENCE).filter((c) => !latest.has(c));
    const lookups = await Promise.all(
      missing.map((channel) =>
        this.supabase
          .from("channel_runs")
          .select(CHANNEL_RUN_COLS)
          .eq("channel", channel)
          .order("ran_at", { ascending: false })
          .limit(1),
      ),
    );
    missing.forEach((channel, i) => {
      const { data: rows, error: err } = lookups[i];
      if (err) throw new Error(err.message);
      const r = (rows?.[0] ?? null) as Record<string, unknown> | null;
      latest.set(
        channel,
        r
          ? toHealthView(channel, r)
          : {
              channel,
              ranAt: null,
              fetched: 0,
              newRows: 0,
              filtered: 0,
              tagged: 0,
              errors: 0,
              ageHours: null,
              cadenceHours: CADENCE[channel] ?? 24,
            },
      );
    });
    return [...latest.values()];
  }

  async setTriage(input: TriageInput): Promise<WriteResult> {
    // Writes go through ONE server-side function that updates the row and
    // appends its audit event in a single transaction. The browser holds no
    // insert/update policy, by design (see db/migrations/0001_init.sql).
    const { data, error } = await this.supabase.rpc("app_set_triage", {
      p_posting_key: input.postingKey,
      p_triage: input.triage,
      p_snooze_until: input.snoozeUntil ?? null,
      p_reason: input.reason ?? "",
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        const [fresh] = await this.userPostings((q) =>
          q.eq("posting_key", input.postingKey).limit(1),
        );
        if (fresh) return { ok: false, kind: "conflict", current: fresh };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const job = toJobView((data ?? {}) as Record<string, unknown>);
    if (!job) {
      const [fresh] = await this.userPostings((q) =>
        q.eq("posting_key", input.postingKey).limit(1),
      );
      if (fresh) return { ok: true, job: fresh };
      return { ok: false, kind: "error", message: "Write succeeded but the row could not be re-read" };
    }
    return { ok: true, job };
  }

  async setTriageBulk(input: BulkTriageInput): Promise<BulkWriteResult> {
    const { data, error } = await this.supabase.rpc("app_set_triage_bulk", {
      p_keys: input.postingKeys,
      p_triage: input.triage,
      p_snooze_until: input.snoozeUntil ?? null,
      p_reason: input.reason ?? "",
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) return { ok: false, kind: "conflict" };
      return { ok: false, kind: "error", message: error.message };
    }
    const rows = (data as { rows?: unknown[] } | null)?.rows ?? [];
    const jobs = rows
      .map((r) => toJobView(r as Record<string, unknown>))
      .filter((j): j is JobView => j !== null);
    return { ok: true, jobs };
  }

  // ---- the company universe (P7) ----------------------------------------

  private async userCompanies(filter?: (q: any) => any): Promise<CompanyView[]> {
    let q = this.supabase
      .from("user_companies")
      .select(
        `company_id, monitor, priority, seeded, review_state, updated_at,
         companies!inner(${COMPANY_COLS})`,
      )
      .eq("user_id", this.userId);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? [])
      .map((r) => toCompanyView(r as Record<string, unknown>))
      .filter((c): c is CompanyView => c !== null);
  }

  companies(): Promise<CompanyView[]> {
    // Ordered by name with an id tiebreak, for `jobs()`'s reason: the cap means
    // the ordering decides WHICH rows survive it, so it cannot be left to the
    // query plan on a tie. Slug-only rows (Common Crawl mines boards, not names)
    // sort under "" — visible at the top rather than lost at the end, since an
    // unnamed row is precisely one a human needs to look at.
    return this.userCompanies((q) =>
      q
        .order("companies(name)", { ascending: true })
        .order("company_id", { ascending: true })
        .limit(5000),
    );
  }

  async setCompanyReviewBulk(input: BulkReviewInput): Promise<BulkReviewResult> {
    const { data, error } = await this.supabase.rpc("app_set_company_review_bulk", {
      p_company_ids: input.companyIds,
      p_review_state: input.reviewState,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) return { ok: false, kind: "conflict" };
      return { ok: false, kind: "error", message: error.message };
    }
    const rows = (data as { rows?: unknown[] } | null)?.rows ?? [];
    const companies = rows
      .map((r) => toCompanyView(r as Record<string, unknown>))
      .filter((c): c is CompanyView => c !== null);
    return { ok: true, companies };
  }

  async setCompanyFlags(input: CompanyFlagsInput): Promise<CompanyFlagsResult> {
    const { data, error } = await this.supabase.rpc("app_set_company_flags", {
      p_company_id: input.companyId,
      p_monitor: input.enabled,
      p_priority: input.priority,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        const [fresh] = await this.userCompanies((q) =>
          q.eq("company_id", input.companyId).limit(1),
        );
        if (fresh) return { ok: false, kind: "conflict", current: fresh };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const company = toCompanyView((data ?? {}) as Record<string, unknown>);
    if (!company) {
      return {
        ok: false,
        kind: "error",
        message: "Write succeeded but the row could not be re-read",
      };
    }
    return { ok: true, company };
  }

  async proposeCompanies(input: ProposeCompaniesInput): Promise<ProposeCompaniesResult> {
    const { data, error } = await this.supabase.rpc("app_propose_companies", {
      p_names: input.names,
      p_source: input.source,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as { rows?: unknown[]; added?: number };
    const companies = (payload.rows ?? [])
      .map((r) => toCompanyView(r as Record<string, unknown>))
      .filter((c): c is CompanyView => c !== null);
    return { ok: true, companies, added: Number(payload.added ?? 0) };
  }

  // ---- the referral finder (0013) ---------------------------------------

  async setLinkedinCompanyId(input: LinkedinCompanyIdInput): Promise<CompanyFlagsResult> {
    const { data, error } = await this.supabase.rpc("app_set_linkedin_company_id", {
      p_company_id: input.companyId,
      p_linkedin_id: input.linkedinId,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        // Re-read rather than echo what was sent: the conflict path's whole job
        // is putting the SERVER's row on screen (matrix row 113).
        const [fresh] = await this.userCompanies((q) =>
          q.eq("company_id", input.companyId).limit(1),
        );
        if (fresh) return { ok: false, kind: "conflict", current: fresh };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const company = toCompanyView((data ?? {}) as Record<string, unknown>);
    if (!company) {
      return {
        ok: false,
        kind: "error",
        message: "Write succeeded but the row could not be re-read",
      };
    }
    return { ok: true, company };
  }

  async connections(): Promise<ConnectionView[]> {
    const { data, error } = await this.supabase
      .from("connections")
      .select(CONNECTION_COLS)
      .eq("user_id", this.userId)
      // Ordered for `companies()`'s reason: the cap decides WHICH rows survive
      // it, so the ordering cannot be left to the query plan on a tie. By name,
      // because that is also the order the popover lists them in.
      .order("full_name", { ascending: true })
      .order("id", { ascending: true })
      .limit(CONNECTION_LIST_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => toConnectionView(r as Record<string, unknown>));
  }

  async importConnections(input: ImportConnectionsInput): Promise<ImportConnectionsResult> {
    const { data, error } = await this.supabase.rpc("app_import_connections", {
      p_rows: input.rows.map((r) => ({
        full_name: r.fullName,
        first_name: r.firstName,
        last_name: r.lastName,
        company: r.company,
        title: r.title,
        profile_url: r.profileUrl,
        connected_on: r.connectedOn,
      })),
      p_source: input.source,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      inserted: Number(row.inserted ?? 0),
      updated: Number(row.updated ?? 0),
      skipped: Number(row.skipped ?? 0),
      deduped: Number(row.deduped ?? 0),
    };
  }

  async clearConnections(input: ClearConnectionsInput): Promise<ClearConnectionsResult> {
    const { data, error } = await this.supabase.rpc("app_clear_connections", {
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const row = (data ?? {}) as Record<string, unknown>;
    return { ok: true, deleted: Number(row.deleted ?? 0) };
  }

  // ---- the warm-intro finder (0020) ---------------------------------------

  async startWarmSearch(input: StartWarmSearchInput): Promise<StartWarmSearchResult> {
    const cap = warmDailyCap();
    const { data, error } = await this.supabase.rpc("app_start_warm_search", {
      p_target_kind: input.targetKind,
      p_posting_key: input.postingKey,
      p_company: input.company,
      p_params: input.params,
      p_overlays: input.overlays,
      p_daily_cap: cap,
      p_idem: input.idempotencyKey,
    });
    if (error) {
      if (error.code === "28000") return { ok: false, kind: "auth" };
      // The one refusal the UI renders as its own state — matched on the SQLSTATE,
      // not the message, so the copy can change without becoming load-bearing.
      if (error.code === WARM_CAP_SQLSTATE) {
        return { ok: false, kind: "over-cap", message: warmOverCapMessage(cap) };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    return { ok: true, search: toWarmSearchView((data ?? {}) as Record<string, unknown>) };
  }

  async attachWarmRun(input: AttachWarmRunInput): Promise<WarmSearchByIdResult> {
    const { data, error } = await this.supabase.rpc("app_attach_warm_run", {
      p_id: input.id,
      // Persisted as [{run_id, persona}] — the persona is what poll re-attributes on.
      p_runs: input.runs.map((r) => ({ run_id: r.runId, persona: r.persona })),
    });
    return this.warmByIdResult(data, error);
  }

  async getWarmSearch(id: string): Promise<WarmSearchView | null> {
    const { data, error } = await this.supabase
      .from("warm_searches")
      .select(WARM_SEARCH_COLS)
      .eq("id", id)
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return toWarmSearchView(data as Record<string, unknown>);
  }

  async completeWarmSearch(input: CompleteWarmSearchInput): Promise<WarmSearchByIdResult> {
    const { data, error } = await this.supabase.rpc("app_complete_warm_search", {
      p_id: input.id,
      p_results: input.results,
    });
    return this.warmByIdResult(data, error);
  }

  async failWarmSearch(input: FailWarmSearchInput): Promise<WarmSearchByIdResult> {
    const { data, error } = await this.supabase.rpc("app_fail_warm_search", {
      p_id: input.id,
      p_error: input.error,
    });
    return this.warmByIdResult(data, error);
  }

  async cancelWarmSearch(id: string): Promise<WarmSearchByIdResult> {
    const { data, error } = await this.supabase.rpc("app_cancel_warm_search", {
      p_id: id,
    });
    return this.warmByIdResult(data, error);
  }

  /** Shared mapping for the four id-scoped warm RPCs (P0002 → a 404, not a 500). */
  private warmByIdResult(
    data: unknown,
    error: { code?: string; message: string } | null,
  ): WarmSearchByIdResult {
    if (error) {
      if (error.code === "28000") return { ok: false, kind: "auth" };
      if (error.code === NO_SUCH_WARM_SEARCH) return { ok: false, kind: "missing" };
      return { ok: false, kind: "error", message: error.message };
    }
    return { ok: true, search: toWarmSearchView((data ?? {}) as Record<string, unknown>) };
  }

  async warmPins(): Promise<WarmPinView[]> {
    const { data, error } = await this.supabase
      .from("warm_pins")
      .select(WARM_PIN_COLS)
      .eq("user_id", this.userId)
      .order("id", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => toWarmPinView(r as Record<string, unknown>));
  }

  async pinWarmIntro(input: PinWarmIntroInput): Promise<PinWarmIntroResult> {
    const { data, error } = await this.supabase.rpc("app_pin_warm_intro", {
      p_target_kind: input.targetKind,
      p_posting_key: input.postingKey,
      p_company: input.company,
      p_full_name: input.fullName,
      p_profile_url: input.profileUrl,
      p_headline: input.headline,
      p_source: input.source,
      p_idem: input.idempotencyKey,
    });
    if (error) {
      if (error.code === "28000") return { ok: false, kind: "auth" };
      return { ok: false, kind: "error", message: error.message };
    }
    return { ok: true, pin: toWarmPinView((data ?? {}) as Record<string, unknown>) };
  }

  async unpinWarmIntro(input: UnpinWarmIntroInput): Promise<UnpinWarmIntroResult> {
    const { data, error } = await this.supabase.rpc("app_unpin_warm_intro", {
      p_id: input.id,
      p_idem: input.idempotencyKey,
    });
    if (error) {
      if (error.code === "28000") return { ok: false, kind: "auth" };
      return { ok: false, kind: "error", message: error.message };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    return { ok: true, deleted: Number(row.deleted ?? 0) };
  }

  // ---- saved views ------------------------------------------------------

  // ---- the search profile (P10) -------------------------------------------

  /**
   * This user's profile row, or the never-onboarded shape when there is none.
   *
   * No row exists until the first save — `handle_new_auth_user` writes `users`
   * only — so "missing" and "criteria = {}" have to mean the same thing here.
   * They do: both are `criteria: null`, which is what the onboarding redirect
   * reads. A missing row silently answering BASE_CRITERIA would drop a brand
   * new user into an empty queue with nothing on screen explaining it.
   */
  async profile(): Promise<ProfileView> {
    const { data, error } = await this.supabase
      .from("profiles")
      .select("criteria, notify, updated_at")
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error || !data) return { criteria: null, notify: {}, updatedAt: null };
    const raw = (data as Record<string, unknown>).criteria;
    return {
      criteria: isOnboarded(raw) ? parseCriteria(raw) : null,
      notify: ((data as Record<string, unknown>).notify ?? {}) as Record<string, unknown>,
      updatedAt: str((data as Record<string, unknown>).updated_at),
    };
  }

  async previewProfile(input: PreviewProfileInput): Promise<PreviewProfileResult> {
    // Clamped ONCE, and the same number is both sent and reported. The SQL
    // clamps `p_days` itself, so sending 3,650 was harmless — but the panel was
    // handed the RAW value and rendered "collected in the last 3650 days" over a
    // 90-day corpus. A false number, on the one screen whose entire job is a
    // number somebody can trust.
    const windowDays = clampWindowDays(input.windowDays);
    const { data, error } = await this.supabase.rpc("app_preview_corpus", {
      p_days: windowDays,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const rows = (data ?? []) as Record<string, unknown>[];
    const corpus: PreviewPosting[] = rows.map((r) => ({
      key: String(r.key ?? ""),
      company: String(r.company ?? ""),
      title: String(r.title ?? ""),
      tags: (r.tags ?? {}) as Record<string, unknown>,
      geo: (r.geo ?? {}) as Record<string, unknown>,
      lastSeen: str(r.last_seen),
      status: str(r.status),
    }));
    // The SAME function the fixture source calls. Two implementations of the
    // arithmetic would let the demo state a number production cannot reproduce,
    // on the one screen whose whole job is stating a trustworthy number.
    return {
      ok: true,
      preview: computePreview(corpus, parseCriteria(input.criteria), {
        windowDays,
        now: new Date().toISOString(),
      }),
    };
  }

  async commitProfile(input: CommitProfileInput): Promise<CommitProfileResult> {
    const { data, error } = await this.supabase.rpc("app_commit_profile", {
      p_criteria: input.criteria,
      p_notify: input.notify ?? null,
      p_regate: input.regate,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        return { ok: false, kind: "conflict", current: await this.profile() };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    const pr = (row.profile ?? {}) as Record<string, unknown>;
    const criteria = pr.criteria;
    return {
      ok: true,
      profile: {
        criteria: isOnboarded(criteria) ? parseCriteria(criteria) : null,
        notify: (pr.notify ?? {}) as Record<string, unknown>,
        updatedAt: str(pr.updated_at),
      },
      restamped: Number(row.restamped ?? 0),
      newlyQualifiedKeys: Array.isArray(row.newly_qualified_keys)
        ? (row.newly_qualified_keys as unknown[]).map(String)
        : [],
    };
  }

  // ---- display preferences (0025) -----------------------------------------

  /**
   * This user's display preferences, or the server's defaults when no row
   * exists — which is every account that has never saved anything, since
   * `handle_new_auth_user` writes `users` only.
   *
   * Fails to the DEFAULTS rather than throwing, and that is the same call the
   * onboarding guard makes for the same reason: this read happens in the root
   * layout, before first paint, on every route including the ones nobody is
   * signed in on. A transient error here must render the app slightly wrong,
   * never blank.
   */
  async displayPrefs(): Promise<DisplayPrefsView> {
    const { data, error } = await this.supabase
      .from("profiles")
      .select(DISPLAY_PREFS_COLS)
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_DISPLAY_PREFS, updatedAt: null };
    return toDisplayPrefsView(data as unknown as Record<string, unknown>);
  }

  async setDisplayPrefs(input: SetDisplayPrefsInput): Promise<SetDisplayPrefsResult> {
    // `?? null` on every value, not a spread of the input: PostgREST sends the
    // keys it is given, and a `undefined` one is omitted from the JSON body
    // entirely — at which point Postgres falls back to the parameter's DEFAULT,
    // which these deliberately do not have. An explicit null is the "leave it"
    // signal the function is written against.
    const { data, error } = await this.supabase.rpc("app_set_display_prefs", {
      p_density: input.density ?? null,
      p_type_scale: input.typeScale ?? null,
      p_keyboard_hints: input.keyboardHints ?? null,
      p_landing_view: input.landingView ?? null,
      p_theme: input.theme ?? null,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      // The same match `commitProfile` uses, on the same word, for the same
      // reason: 0025 raises `conflict: your display preferences changed …`.
      if (/conflict|stale/i.test(error.message)) {
        return { ok: false, kind: "conflict", current: await this.displayPrefs() };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      prefs: toDisplayPrefsView(row.display),
      changed: row.changed === true,
    };
  }

  // ---- the answer library (0014) ------------------------------------------

  /**
   * The library, as the engine and the settings screen both read it.
   *
   * `authored_by` is in the select for the reason `lib/apply/index.ts` puts in
   * bold: every gate in `prepare.ts` that could touch a knockout or a demographic
   * field reads THAT column, so a select without it turns each of those rows into
   * a gap — silently, and with the row visibly present on the settings page.
   *
   * `question_key` comes from the column too. It is `generated always as` and it
   * is the identity the unique index enforces; recomputing it in the browser is
   * how two sides end up disagreeing about which row they are talking about.
   */
  async answers(): Promise<AnswerView[]> {
    const { data, error } = await this.supabase
      .from("answers")
      .select(
        "question, question_key, company_key, answer, declined, kind, provenance, authored_by, confirmed_at, updated_at",
      )
      .eq("user_id", this.userId)
      // Ordered so the cap decides WHICH rows survive it rather than the query
      // plan, and by the key the page groups on. `connections()`' rule.
      // `company_key` joins it as 0017's second half of the identity: without it
      // the two scopes of one question tie, and a tie is the query plan deciding.
      .order("question_key", { ascending: true })
      .order("company_key", { ascending: true })
      .limit(APPLY_LIBRARY_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => toAnswerView(r as Record<string, unknown>));
  }

  async policyRules(): Promise<PolicyRuleView[]> {
    const { data, error } = await this.supabase
      .from("answer_policies")
      .select("topic, company_key, fact, provenance, authored_by, note, enabled, updated_at")
      .eq("user_id", this.userId)
      .order("topic", { ascending: true })
      .order("company_key", { ascending: true })
      .limit(APPLY_LIBRARY_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => toPolicyRuleView(r as Record<string, unknown>));
  }

  /** One library row by its full identity, for the conflict path's re-read. */
  private async oneAnswer(questionKey: string, companyKey: string): Promise<AnswerView | null> {
    const { data, error } = await this.supabase
      .from("answers")
      .select(
        "question, question_key, company_key, answer, declined, kind, provenance, authored_by, confirmed_at, updated_at",
      )
      .eq("user_id", this.userId)
      .eq("question_key", questionKey)
      // The scope, or `maybeSingle` throws on the day somebody has both — which
      // is the day 0017 exists for, and it would turn a conflict into a crash.
      .eq("company_key", companyKey)
      .maybeSingle();
    if (error || !data) return null;
    return toAnswerView(data as Record<string, unknown>);
  }

  private async onePolicyRule(topic: string, companyKey: string): Promise<PolicyRuleView | null> {
    const { data, error } = await this.supabase
      .from("answer_policies")
      .select("topic, company_key, fact, provenance, authored_by, note, enabled, updated_at")
      .eq("user_id", this.userId)
      .eq("topic", topic)
      .eq("company_key", companyKey)
      .maybeSingle();
    if (error || !data) return null;
    return toPolicyRuleView(data as Record<string, unknown>);
  }

  /**
   * There is no `p_authored_by`, and this method is where somebody would add
   * one. 0014's trigger stamps the column from `auth.uid()`; a parameter here
   * would hand a caller the one field every knockout gate keys on.
   */
  async upsertAnswer(input: UpsertAnswerInput): Promise<AnswerWriteResult> {
    const { data, error } = await this.supabase.rpc("app_upsert_answer", {
      p_question: input.question,
      p_answer: input.answer,
      p_kind: input.kind,
      p_provenance: input.provenance,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
      // 0017. `p_company` is a NAME and the function keys it, so this side never
      // normalizes what the store owns.
      p_company: input.company,
      p_declined: input.declined,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        // Re-read rather than echo what was sent: the conflict path's job is to
        // put the OTHER device's value on screen, and the value that lost is
        // exactly what the caller already has.
        return {
          ok: false,
          kind: "conflict",
          current: await this.oneAnswer(
            questionKey(input.question),
            companyNameKey(input.company),
          ),
        };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      answer: toAnswerView((row.answer ?? {}) as Record<string, unknown>),
      created: row.created === true,
    };
  }

  async deleteAnswer(input: DeleteAnswerInput): Promise<DeleteAnswerResult> {
    const { data, error } = await this.supabase.rpc("app_delete_answer", {
      p_question: input.question,
      p_company: input.company,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const row = (data ?? {}) as Record<string, unknown>;
    return { ok: true, deleted: row.deleted === true };
  }

  async setPolicyRule(input: SetPolicyRuleInput): Promise<PolicyWriteResult> {
    const { data, error } = await this.supabase.rpc("app_set_policy_rule", {
      p_topic: input.topic,
      p_company: input.company,
      p_fact: input.fact,
      p_provenance: input.provenance,
      p_note: input.note,
      p_enabled: input.enabled,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (/conflict|stale/i.test(error.message)) {
        return {
          ok: false,
          kind: "conflict",
          current: await this.onePolicyRule(input.topic, companyNameKey(input.company)),
        };
      }
      return { ok: false, kind: "error", message: error.message };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      rule: toPolicyRuleView((row.rule ?? {}) as Record<string, unknown>),
      created: row.created === true,
    };
  }

  async deletePolicyRule(input: DeletePolicyRuleInput): Promise<DeletePolicyResult> {
    const { data, error } = await this.supabase.rpc("app_delete_policy_rule", {
      p_topic: input.topic,
      p_company: input.company,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const row = (data ?? {}) as Record<string, unknown>;
    return { ok: true, deleted: row.deleted === true };
  }

  async savedViews(surface: string): Promise<SavedView[]> {
    const { data, error } = await this.supabase
      .from("saved_views")
      .select("id, surface, name, state, is_default, updated_at")
      .eq("user_id", this.userId)
      .eq("surface", surface)
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toSavedView);
  }

  async saveView(input: SaveViewInput): Promise<SaveViewResult> {
    const { data, error } = await this.supabase.rpc("app_save_view", {
      p_id: input.id,
      p_name: input.name,
      p_surface: input.surface,
      p_state: input.state,
      p_is_default: input.isDefault,
      p_idem: input.idempotencyKey,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      // Same "conflict" string the write path matches on — keep it in step.
      if (/conflict|stale/i.test(error.message)) return { ok: false, kind: "conflict" };
      return { ok: false, kind: "error", message: error.message };
    }
    const view = toSavedView((data ?? {}) as Record<string, unknown>);
    return { ok: true, view };
  }

  async deleteView(input: DeleteViewInput): Promise<DeleteViewResult> {
    const { error } = await this.supabase.rpc("app_delete_view", {
      p_id: input.id,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    return { ok: true };
  }

  // ---- import (P9) ------------------------------------------------------
  //
  // Thin on purpose. Every rule an import has to obey — the merge authorisation,
  // the human-status lock, the blank-never-erases rule, the undo window, AC 23's
  // refusal — lives in migration 0011, because there are two callers (this class
  // and, one day, a script) and only the database sees both. What is here is the
  // shape translation and the classification of an error the UI must distinguish.

  async imports(): Promise<ImportBatchView[]> {
    const { data, error } = await this.supabase
      .from("import_batches")
      .select(IMPORT_BATCH_COLS)
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(IMPORT_LIST_LIMIT);
    if (error) throw new Error(error.message);
    // `staged_count` is computed by the RPC and absent from a plain select, so
    // the row count comes from the column. Stated rather than papered over: the
    // landing list shows a total, and the wizard's progress bar — which needs
    // the real staged figure — reads it from the RPC result instead.
    return (data ?? []).map((r) => toImportBatchView(r as Record<string, unknown>));
  }

  async importBatch(
    batchId: string,
  ): Promise<{ batch: ImportBatchView; rows: ImportRowView[] } | null> {
    const { data, error } = await this.supabase
      .from("import_batches")
      .select(IMPORT_BATCH_COLS)
      .eq("user_id", this.userId)
      .eq("id", batchId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    const { data: rows, error: rowsError } = await this.supabase
      .from("import_rows")
      .select(IMPORT_ROW_COLS)
      .eq("user_id", this.userId)
      .eq("batch_id", batchId)
      .order("row_number", { ascending: true })
      // The same 5,000-row cap the upload enforces. A bound on every read that
      // can grow, or one pathological batch is a page that never renders.
      .limit(5000);
    if (rowsError) throw new Error(rowsError.message);

    const batch = toImportBatchView(data as Record<string, unknown>);
    // The honest staged count, from the rows actually present.
    batch.stagedCount = (rows ?? []).length;
    return {
      batch,
      rows: (rows ?? []).map((r) => toImportRowView(r as Record<string, unknown>)),
    };
  }

  async createImport(input: CreateImportInput): Promise<ImportBatchResult> {
    return this.importBatchRpc("app_import_create", {
      p_idem: input.idempotencyKey,
      p_filename: input.filename,
      p_source_kind: input.sourceKind,
      p_content_hash: input.contentHash,
      p_row_count: input.rowCount,
    });
  }

  async stageImportRows(input: StageImportInput): Promise<StageImportResult> {
    const { data, error } = await this.supabase.rpc("app_import_stage", {
      p_batch: input.batchId,
      p_rows: input.rows.map((r) => ({ row_number: r.rowNumber, raw: r.raw })),
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as { staged?: number; total?: number };
    return { ok: true, staged: Number(payload.staged ?? 0), total: Number(payload.total ?? 0) };
  }

  async setImportMapping(input: SetImportMappingInput): Promise<ImportBatchResult> {
    return this.importBatchRpc(
      "app_import_set_mapping",
      {
        p_batch: input.batchId,
        p_rows: input.rows.map((r) => ({
          row_number: r.rowNumber,
          mapped: r.mapped,
          job_key: r.jobKey,
          key_strength: r.keyStrength,
        })),
        p_mapping: input.mapping,
        p_final: input.final,
        p_expected_updated_at: input.expectedUpdatedAt,
      },
      "batch",
    );
  }

  async previewImport(batchId: string): Promise<ImportPreviewResult> {
    const { data, error } = await this.supabase.rpc("app_import_preview", {
      p_batch: batchId,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      batch: toImportBatchView((payload.batch ?? {}) as Record<string, unknown>),
      counts: (payload.counts ?? {}) as ImportCounts,
      unresolved: Number(payload.unresolved ?? 0),
    };
  }

  async resolveImportRow(input: ResolveImportRowInput): Promise<ResolveImportRowResult> {
    const { data, error } = await this.supabase.rpc("app_import_resolve", {
      p_batch: input.batchId,
      p_row: input.rowNumber,
      p_choices: input.choices,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as { unresolved?: number };
    return { ok: true, unresolved: Number(payload.unresolved ?? 0) };
  }

  async setImportRowsIncluded(input: IncludeImportRowsInput): Promise<StageImportResult> {
    const { data, error } = await this.supabase.rpc("app_import_set_included", {
      p_batch: input.batchId,
      p_rows: input.rowNumbers,
      p_included: input.included,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as { rows?: number };
    return { ok: true, staged: Number(payload.rows ?? 0), total: Number(payload.rows ?? 0) };
  }

  async commitImportChunk(input: CommitImportInput): Promise<ImportCommitResult> {
    const { data, error } = await this.supabase.rpc("app_import_commit_chunk", {
      p_batch: input.batchId,
      p_limit: input.limit,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      batch: toImportBatchView((payload.batch ?? {}) as Record<string, unknown>),
      created: Number(payload.created ?? 0),
      updated: Number(payload.updated ?? 0),
      skipped: Number(payload.skipped ?? 0),
      failed: Number(payload.failed ?? 0),
      remaining: Number(payload.remaining ?? 0),
    };
  }

  async importReport(batchId: string): Promise<ImportColumnReportView[]> {
    const { data, error } = await this.supabase.rpc("app_import_report", {
      p_batch: batchId,
    });
    if (error) throw new Error(error.message);
    const payload = (data ?? {}) as { columns?: unknown[] };
    return (payload.columns ?? []).map((c) => {
      const r = c as Record<string, unknown>;
      return {
        column: String(r.column ?? ""),
        disposition: String(r.disposition ?? "unmapped") as ImportColumnReportView["disposition"],
        rows: Number(r.rows ?? 0),
        sample: Array.isArray(r.sample) ? r.sample.map((s) => String(s)) : [],
      };
    });
  }

  async undoImport(input: UndoImportInput): Promise<ImportUndoResult> {
    const { data, error } = await this.supabase.rpc("app_import_undo", {
      p_batch: input.batchId,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    const payload = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      batch: toImportBatchView((payload.batch ?? {}) as Record<string, unknown>),
      deleted: Number(payload.deleted ?? 0),
      reverted: Number(payload.reverted ?? 0),
      kept: Number(payload.kept ?? 0),
      keptIds: Array.isArray(payload.kept_ids) ? payload.kept_ids.map((x) => Number(x)) : [],
      notesKept: Number(payload.notes_kept ?? 0),
    };
  }

  async discardImport(input: DiscardImportInput): Promise<DiscardImportResult> {
    const { error } = await this.supabase.rpc("app_import_discard", {
      p_batch: input.batchId,
      p_idem: input.idempotencyKey,
    });
    if (error) return { ok: false, kind: "error", message: error.message };
    return { ok: true };
  }

  /**
   * The two RPCs that answer with a batch, and the one place `conflict` is
   * classified.
   *
   * The word is load-bearing: 0011 raises "conflict: this import changed since
   * you read it" and this is what turns that into the banner rather than a
   * generic red toast — the same contract `setTriage` and `saveView` rely on, and
   * `tests/core/test_migrations.py` pins the string to the SQL.
   */
  private async importBatchRpc(
    fn: string,
    args: Record<string, unknown>,
    key?: "batch",
  ): Promise<ImportBatchResult> {
    const { data, error } = await this.supabase.rpc(fn, args);
    if (error) {
      if (/conflict|stale/i.test(error.message)) return { ok: false, kind: "conflict" };
      return { ok: false, kind: "error", message: error.message };
    }
    const payload = (data ?? {}) as Record<string, unknown>;
    const row = key ? ((payload[key] ?? {}) as Record<string, unknown>) : payload;
    return { ok: true, batch: toImportBatchView(row) };
  }
}

/** Mirrors tracker/digest.py CADENCE_HOURS — keep in step. */
export const CADENCE: Record<string, number> = {
  monitor: 12, review: 24, tracker: 2, cafe: 24, theirstack: 24,
  simplify: 24, selfheal: 24, snapshot: 24, capture: 1.5,
};

function toHealthView(channel: string, r: Record<string, unknown>): ChannelHealthView {
  const ranAt = str(r.ran_at);
  return {
    channel,
    ranAt,
    fetched: Number(r.fetched ?? 0),
    newRows: Number(r.new_rows ?? 0),
    filtered: Number(r.filtered ?? 0),
    tagged: Number(r.tagged ?? 0),
    errors: Number(r.errors ?? 0),
    ageHours: ranAt ? (Date.now() - new Date(ranAt).getTime()) / 3_600_000 : null,
    cadenceHours: CADENCE[channel] ?? 24,
  };
}
