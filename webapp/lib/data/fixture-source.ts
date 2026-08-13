/**
 * Fixture-backed DataSource: an in-memory store for demo mode and tests.
 *
 * It is faithful about the things that can actually hurt, because a fake that
 * only models the happy path lets exactly those bugs through:
 *
 *   - **Optimistic concurrency.** A write whose `expectedUpdatedAt` is stale
 *     returns a conflict, so the UI's conflict path is exercised rather than
 *     assumed.
 *   - **Idempotency.** Replaying a key returns the first result instead of
 *     applying twice — a double-tap must be free.
 *   - **Injectable failure.** `failNextWrite()` makes the revert-and-toast
 *     path testable without unplugging anything.
 */
import type {
  AppWriteResult,
  BulkReviewInput,
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
  ResolveJobLinksInput,
  ResolveJobLinksResult,
  AddJobInput,
  AddJobResult,
} from "./source";
import {
  APPLY_LIBRARY_LIMIT,
  CONNECTION_LIST_LIMIT,
  IMPORT_LIST_LIMIT,
  MAX_CONNECTION_CHUNK,
} from "./source";
import { warmDailyCap, warmOverCapMessage } from "@/lib/warm/config";
import { questionKey } from "@/lib/apply/normalize";
import { POLICY_TOPICS } from "@/lib/apply/policy";
import {
  isAnswerKind,
  parseSituationFact,
  toAnswerView,
  toPolicyRuleView,
  type AnswerView,
  type PolicyRuleView,
} from "@/lib/apply/views";
import {
  FIXTURE_APPLY_LIBRARY,
  type ApplyLibrarySeed,
} from "./apply-fixtures";
import {
  FIXTURE_APPLICATIONS,
  FIXTURE_BOT_RUNS,
  FIXTURE_HEALTH,
  FIXTURE_JOBS,
  FIXTURE_NOW,
} from "./fixtures";
import { FIXTURE_PROFILE, PREVIEW_CORPUS, PREVIEW_MAX_ROWS } from "./preview-fixtures";
import { clampWindowDays, computePreview } from "@/lib/profile/preview";
import { isOnboarded, parseCriteria } from "@/lib/profile/criteria";
import {
  DENSITIES,
  LANDING_VIEW_MAX,
  TYPE_SCALES,
} from "@/lib/display/prefs";
// The Supabase source's mapper, imported rather than re-implemented — matrix
// row 212 again: two mappings for one row is where the fake and production
// quietly stop agreeing.
import { toDisplayPrefsView } from "./supabase-source";

/** The columns the no-op guard compares. The version token is not one of them. */
const DISPLAY_COLUMNS = [
  "display_density",
  "display_type_scale",
  "display_keyboard_hints",
  "display_landing_view",
] as const;
import type { Disposition } from "./view-models";
import { FIXTURE_COMPANIES } from "./company-fixtures";
import { isTerminalStatus } from "@/lib/status";
import {
  CLEARABLE_COLUMNS,
  isClearableColumn,
  isUnsetMarker,
  isWritableColumn,
  MAPPED_KEY,
  WRITABLE_COLUMNS,
} from "@/lib/import/round-trip";
import {
  EMPTY_IMPORT_MAPPING,
  type ImportBatchView,
  type ImportColumnReportView,
  type ImportCounts,
  type ImportRowView,
} from "@/lib/import/views";
import { activityFromRuns, blankTrim, companyNameKey, PROPOSE_SOURCE_TAGS } from "./view-models";
import type {
  ActivityView,
  ApplicationView,
  BotRunRow,
  ChannelHealthView,
  CompanyView,
  ConnectionView,
  JobView,
  NoteView,
  SavedView,
} from "./view-models";
import { FIXTURE_CONNECTIONS } from "./connection-fixtures";
import { resolveJobLinks as resolveJobLinksWith } from "@/lib/quickadd/resolve";
import { UNREADABLE as UNREADABLE_POSTING } from "@/lib/quickadd/links";
import { toLocalIsoDate } from "@/lib/dates";
import { CONNECTION_SOURCE_TAGS } from "@/lib/referral/connections";

/** 0008's ceiling on one user's review pile. */
const MAX_PENDING_PROPOSALS = 2000;

const DEFAULT_QUEUE_LIMIT = 20;

/**
 * The queue contract, in one place: freshest first by firstSeen, key
 * descending on a tie. This used to stop at firstSeen while production
 * ordered by a different column with no tiebreak at all, so demo order was
 * stable and production order was whatever the query plan produced — the
 * divergence tests/unit/parity.test.ts now pins. The tie direction is
 * arbitrary but load-bearing once chosen (visual baselines encode it);
 * descending happens to keep the order the fixture set has always shown.
 * A missing date sorts last rather than crashing.
 */
function byFreshness(a: JobView, b: JobView): number {
  return (
    (b.firstSeen ?? "").localeCompare(a.firstSeen ?? "") ||
    (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)
  );
}

/**
 * Two version tokens naming the same moment — never two renderings compared as
 * text. The mirror of the SQL's `::timestamptz` casts (`hq_import_version`, and
 * `app_import_undo` since the fix pass). A null on either side is "no token",
 * which is distinct from every real instant, including another null.
 */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
}

/**
 * An import row plus the three things the STORE needs and the UI must not see.
 *
 * They are the fake's stand-ins for columns the migration really has —
 * `mapped_at`, and `revert` holding `{before, wrote_updated_at}`. Kept off
 * `ImportRowView` deliberately: a view model carrying undo bookkeeping invites a
 * component to render it, and `wroteUpdatedAt` on screen means nothing to
 * anybody.
 */
type FixtureImportRow = ImportRowView & {
  /** Has the mapping reached this row? The mirror of `import_rows.mapped_at`. */
  mappedAt?: boolean;
  /** The `updated_at` this import wrote. Undo compares against it (row 33). */
  wroteUpdatedAt?: string | null;
  /**
   * Which writable columns actually LANDED — the mirror of `revert.wrote`.
   *
   * The report cannot re-derive this and was not trying to: it counted every row
   * whose file value was non-empty, so a Status skipped for the human lock was
   * reported as `locked` AND as `imported`, and a cell the resolver answered
   * "keep mine" was reported as imported while the row still held the old value.
   * Only the commit knows.
   */
  wroteColumns?: string[];
  /**
   * Which clearable columns the unset marker actually ERASED — the mirror of
   * `revert.cleared`. Only the commit knows, for `wroteColumns`'s reason: a
   * marker the resolver answered 'mine', or one that found the field already
   * empty, cleared nothing and must not be reported as if it had.
   */
  clearedColumns?: string[];
  /** The values as they were, for the revert. */
  revertBefore?: {
    status: string;
    statusActor: "system" | "user";
    nextAction: string | null;
    nextActionDate: string | null;
    appliedDate: string | null;
  };
};

/** `public.answers` as the store holds it — including the GENERATED key. */
type AnswerRowShape = {
  question: string;
  question_key: string;
  /** 0017's scope: `''` is every board, a key is one company. */
  company_key: string;
  answer: string;
  declined: boolean;
  kind: string;
  provenance: string;
  authored_by: string;
  confirmed_at: string | null;
  updated_at: string;
};

/** `public.answer_policies` as the store holds it — `fact` still raw jsonb. */
type PolicyRowShape = {
  topic: string;
  company_key: string;
  fact: unknown;
  provenance: string;
  authored_by: string;
  note: string;
  enabled: boolean;
  updated_at: string;
};

const POLICY_TOPIC_SET: ReadonlySet<string> = new Set(POLICY_TOPICS);

/**
 * CHARACTERS, the way Postgres's `length()` counts them.
 *
 * `String.length` counts UTF-16 code units, so every astral character counts
 * twice: a 1,500-emoji question is 1,500 characters to Postgres and 3,000 to
 * JavaScript. The fake refused `question too long: 3002 characters` for a
 * question the database accepts — the SAFE direction, and still a divergence in
 * a fake whose whole job is answering the same question as the store.
 */
function charLength(s: string): number {
  return [...s].length;
}

/**
 * The fake's bound on a `fact`, and why it is NOT 8192.
 *
 * `app_set_policy_rule` refuses `pg_column_size(p_fact) > 8192` — the size of
 * jsonb's BINARY form. This side can only measure the text, and jsonb is larger
 * than its text: each element carries a 4-byte JEntry on top of its bytes. So the
 * two measurements diverge, and the first version diverged the DANGEROUS way —
 * executed against real Postgres, a 679-element `countries` fact was 7,499 text
 * bytes (accepted here) and 8,196 binary bytes (`fact too large: 8196 bytes`
 * there). A fake kinder than the store near a boundary is the exact failure class
 * `parity.test.ts` exists for.
 *
 * The bound is therefore the store's, divided by the worst ratio the shapes
 * `parseSituationFact` admits can reach. The worst is `countries` full of
 * one-character strings: text is `4N` bytes, jsonb is `5N` plus a fixed header,
 * so 1.25. 8192 / 1.25 = 6553; 6 KiB rounds it down and states the margin.
 *
 * The consequence, stated rather than discovered: between 6 KiB and the store's
 * real ceiling this side refuses rows Postgres would take. That is the direction
 * `lib/apply/views.ts` already declares for `countries` and `date` — this side
 * refuses rows the database accepts, never the reverse — and a country list is a
 * handful of short strings.
 */
const MAX_FACT_TEXT_BYTES = 6144;

/**
 * The row a manually added posting is born as: a key, a URL, and honest
 * absence everywhere else.
 *
 * Every optional fact is null rather than "", and that distinction is what the
 * grid renders as `Not listed`. A quick-added job that carried an empty string
 * in `workModel` would print an empty cell — an absent fact presented as a
 * blank one, which is the display defect `04 §5 Missing optional fact` exists
 * to catch. It is also exactly what the row looks like coming back out of
 * Postgres: `postings` defaults these to null, and `tags`/`geo` to `{}`.
 */
function blankJobView(key: string): JobView {
  return {
    key,
    company: "",
    title: "",
    url: "",
    location: null,
    metro: null,
    market: null,
    country: null,
    remote: false,
    workModel: null,
    compRange: null,
    compMinK: null,
    compMaxK: null,
    minYoe: null,
    seniority: null,
    industry: null,
    roleFocus: null,
    skills: [],
    posted: null,
    firstSeen: null,
    taggedAt: null,
    status: "New",
    // `qualified`, and not because anything gated it: the user asked for this
    // posting by name, which is a stronger signal than the profile gate is
    // trying to approximate. `disposition_reason` says so rather than leaving
    // a blank that reads as "the gate passed it".
    disposition: "qualified",
    dispositionReason: "added:you",
    triage: "",
    snoozeUntil: null,
    companyDomain: null,
    updatedAt: null,
  };
}

export class FixtureDataSource implements DataSource {
  private jobsByKey = new Map<string, JobView>();
  private apps: ApplicationView[];
  private seenIdempotencyKeys = new Map<string, WriteResult>();
  private failNext: string | null = null;
  /** Seam tokens already armed once — see `failNextWrite`. */
  private armedTokens = new Set<string>();

  private channels: ChannelHealthView[];
  private botRuns: BotRunRow[];

  /**
   * Every collection comes from the constructor, including health.
   *
   * `health()` used to return the fixture unconditionally while postings and
   * applications were injectable, so a store built with no data still reported
   * six healthy channels — and a zero-row /health was unreachable through the
   * only source the tests can drive. That page consequently shipped rendering
   * six column headings over an empty table body, on the one surface whose
   * entire job is saying whether the machinery is alive. A fake that is more
   * forgiving than reality hides exactly the bug it exists to catch.
   */
  constructor(
    seed: JobView[] = FIXTURE_JOBS,
    apps: ApplicationView[] = FIXTURE_APPLICATIONS,
    channels: ChannelHealthView[] = FIXTURE_HEALTH,
    companies: CompanyView[] = FIXTURE_COMPANIES,
    // The profile is a collection this fake owns, so it comes from the
    // constructor for the same reason health does: the never-onboarded state
    // (`criteria = '{}'`) has to be reachable through the only source the tests
    // can drive, or the middleware redirect and the whole wizard ship
    // unexercised.
    profile: ProfileView = FIXTURE_PROFILE,
    // Injectable for health's reason, and the empty state here is not a corner:
    // a user who has never uploaded an export is EVERY user on day one, and the
    // /connections empty state plus the warm cell's "import your connections"
    // branch are what they see. A fake that always had connections would ship
    // both unlooked-at.
    //
    // Clearing this ALONE is what the second of those needs, which is why
    // `get-source.ts` has a `no-connections` seed and not just `empty`: `empty`
    // clears the postings too, so there is no row to carry a chip and the branch
    // stays unreachable. The build log claimed `empty` covered it; it did not.
    connections: ConnectionView[] = FIXTURE_CONNECTIONS,
    // Injectable for the same reason as every collection above it, and this one
    // has two empty states that matter rather than one: a person with no answers
    // at all (the settings surface's "nothing here yet") and a person with
    // answers but no rule for a knockout topic (every staged application blocked
    // on a question only they can answer). The second is the state the whole
    // feature is judged on, so it is seeded rather than reachable only by hand.
    library: ApplyLibrarySeed = FIXTURE_APPLY_LIBRARY,
    // Injectable for health's exact reason: the `empty` seed must produce a
    // zero-row Activity tab, or its empty state ("nothing has reported yet")
    // ships unlooked-at — and the parity test needs to drive the SAME raw runs
    // through both sources, which only injection allows.
    botRuns: BotRunRow[] = FIXTURE_BOT_RUNS,
  ) {
    // Stored as the DATABASE stores it — a jsonb object, `{}` for a profile
    // nobody has completed — rather than as the view model. `profile()` then maps
    // it the way `SupabaseDataSource` does, which is what makes `isOnboarded`
    // reachable at all through the fake: holding the ProfileView verbatim
    // modelled the RESULT and never the MAPPING, and a `return true` inside
    // `isOnboarded` survived the entire suite.
    this.profileCriteria = profile.criteria ? { ...profile.criteria } : {};
    this.profileNotify = { ...profile.notify };
    this.profileUpdatedAt = profile.updatedAt;
    for (const j of seed) this.jobsByKey.set(j.key, { ...j });
    this.apps = apps.map((a) => ({ ...a }));
    this.channels = channels.map((c) => ({ ...c }));
    this.botRuns = botRuns.map((r) => ({ ...r }));
    // Injectable for the same reason health is: the `empty` demo seed must be
    // able to produce a zero-row /companies, or its empty state ships unlooked-at
    // (matrix row 15's lesson, and the "every collection a fake owns comes from
    // its constructor" rule that followed it).
    for (const c of companies) this.companiesById.set(c.id, { ...c });
    for (const c of connections) this.connectionsById.set(c.id, { ...c });

    // The generated column, generated. A seed supplies `question` and the store
    // computes the key from it — which is what makes the normalizer part of what
    // every fixture-driven test exercises, rather than a function only the unit
    // tests reach. Last seed wins on a collision, exactly as the unique index
    // would leave one row standing.
    for (const a of library.answers) {
      const key = questionKey(a.question);
      if (key === "") continue;
      const companyKey = companyNameKey(a.companyKey ?? "");
      this.answerRows.set(this.answerKey(key, companyKey), {
        question: a.question,
        question_key: key,
        company_key: companyKey,
        answer: a.answer,
        declined: a.declined === true,
        kind: a.kind,
        provenance: a.provenance,
        authored_by: a.authoredBy,
        confirmed_at: a.confirmedAt ?? null,
        updated_at: a.updatedAt ?? FIXTURE_NOW,
      });
    }
    for (const r of library.rules) {
      this.ruleRows.set(this.ruleKey(r.topic, r.companyKey), {
        topic: r.topic,
        company_key: r.companyKey,
        fact: r.fact,
        provenance: r.provenance,
        authored_by: r.authoredBy,
        note: r.note ?? "",
        enabled: r.enabled !== false,
        updated_at: r.updatedAt ?? FIXTURE_NOW,
      });
    }

    // 0010's backfill, reproduced: one `import`-authored note per non-empty flat
    // `notes` column, and the column left in place. Without this the fake starts
    // with an empty history for rows that visibly have a note, so the notes
    // dialog's populated state would be unreachable through the only source the
    // tests can drive — matrix row 15's failure, on a new surface.
    for (const a of this.apps) {
      const flat = blankTrim(a.notes ?? "");
      if (flat) this.appendNote(a.id, flat, "import");
    }
  }

  /**
   * Force the next write to fail, so the UI's failure path can be tested.
   *
   * `token` makes an arming happen ONCE per store, and it exists because of a
   * bug that only showed under load. `?demo=failnext` is applied by the page
   * component, and a page component runs again on the RSC re-render every server
   * action produces — so the failed write re-armed the seam on its way back, and
   * the RETRY failed too. `pipeline.spec.ts`'s idempotency test then found no
   * note at all, deterministically in a full run and never in isolation, because
   * whether the re-render lands before the click is a question about the machine.
   *
   * The demo behaviour is the same fix: "make the next write fail" is one write,
   * not every write for as long as the parameter stays in the address bar.
   *
   * The COOKIE path (`hq_demo_fail`) passes no token and keeps arming on every
   * resolve — that one is armed and cleared by a test that owns both ends.
   */
  failNextWrite(message = "Network unavailable", token?: string): void {
    if (token !== undefined) {
      if (this.armedTokens.has(token)) return;
      this.armedTokens.add(token);
    }
    this.failNext = message;
  }

  /**
   * `companyNameKey` → domain, out of the COMPANY universe — the fixture half of
   * `SupabaseDataSource.companyDomains()`, and the reason it exists at all.
   *
   * A posting carries a company NAME and no FK to `companies`, so in production a
   * job's `companyDomain` is RESOLVED from the user's company universe by name key
   * and is null for every company outside it. The fixture set used to hard-code
   * `companyDomain` on the job seeds instead, which made the fake strictly more
   * generous than the real client in the way this project has now been bitten five
   * times: `Plaid`, `Mercury`, `Modern Treasury` and `Stripe` all carried a domain in
   * the demo and would render a monogram in production, because none of them is in
   * the company universe — and the LogoAvatar is being built against that demo. A
   * component tuned on a fixture where most rows have a logo would ship for a product
   * where most rows do not.
   *
   * Derived per call rather than cached: `setCompanyDomain`-shaped writes do not
   * exist yet, but `resolveCompany`/`setCompanyReview` mutate `companiesById`, and a
   * map built in the constructor would answer from before the write.
   */
  private companyDomains(): Map<string, string> {
    const map = new Map<string, string>();
    for (const c of this.companiesById.values()) {
      const key = companyNameKey(c.name);
      if (key && c.domain) map.set(key, c.domain);
    }
    return map;
  }

  /**
   * Fold the company-domain map onto a batch of jobs — `SupabaseDataSource`'s
   * `applyDomains`, with the same "missing → null" ending. Not `?? j.companyDomain`:
   * on the Supabase side that fallback reads a field `toJobView` always sets to null,
   * so keeping a seeded value here would be the divergence, not the parity.
   */
  private applyDomains(jobs: JobView[]): JobView[] {
    const domains = this.companyDomains();
    return jobs.map((j) => ({
      ...j,
      companyDomain: domains.get(companyNameKey(j.company)) ?? null,
    }));
  }

  async queue(opts: QueueOptions = {}): Promise<JobView[]> {
    const limit = opts.limit ?? DEFAULT_QUEUE_LIMIT;
    return this.applyDomains(
      [...this.jobsByKey.values()]
        // The third clause is acceptance criterion 16 and it was missing here
        // while `SupabaseDataSource.queue()` has always had it
        // (`.neq("postings.status", "Closed")`). A fake more permissive than the
        // real client is how this project has been bitten four times now: the
        // fixture would have served a delisted role as decidable work, and no
        // test could have caught it because no fixture was Closed.
        .filter(
          (j) =>
            j.disposition === "qualified" &&
            j.triage === "" &&
            (j.status ?? "").trim().toLowerCase() !== "closed",
        )
        .sort(byFreshness)
        .slice(0, limit)
        .map((j) => ({ ...j })),
    );
  }

  async jobs(): Promise<JobView[]> {
    return this.applyDomains(
      [...this.jobsByKey.values()].sort(byFreshness).map((j) => ({ ...j })),
    );
  }

  async applications(): Promise<ApplicationView[]> {
    // `withNotes` rather than a bare copy: `noteCount`/`latestNote` are DERIVED
    // in `app_application_row`, so a fake that served the constructor's values
    // would show a stale count the moment a note was added — and every test
    // asserting a note landed would pass against a number nothing maintains.
    return this.apps.map((a) => this.withNotes(a));
  }

  /**
   * The board's status for a posting, so the delisted badge can be derived.
   *
   * Mirrors the `postings(status)` embed and its RLS limitation: only postings
   * this store knows about answer, and everything else is null. An application
   * whose posting is not in the store therefore reads as still-listed, which is
   * the same false negative production has.
   */
  private postingStatusFor(app: ApplicationView): string | null {
    if (!app.postingKey) return null;
    return this.jobsByKey.get(app.postingKey)?.status ?? null;
  }

  async health(): Promise<ChannelHealthView[]> {
    return this.channels.map((h) => ({ ...h }));
  }

  async getActivity(): Promise<ActivityView[]> {
    // The SAME mapper the Supabase source calls, over the same raw shape — the
    // parity test drives one raw run set through both and asserts they agree.
    // No user filter here and none needed: a fixture store holds exactly one
    // user's world, which is what the Supabase read narrows itself down TO.
    // The narrowing is proven on the query side (activity.test.ts), because it
    // is a property of the query, not of the mapping the two share.
    return activityFromRuns(this.botRuns.map((r) => ({ ...r })));
  }

  async setTriage(input: TriageInput): Promise<WriteResult> {
    const replay = this.seenIdempotencyKeys.get(input.idempotencyKey);
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    // The database refuses these before touching the row — 0003_write_path.sql
    // validates and 0002's snooze_has_a_date CHECK backstops it. The fixture
    // accepted them, so the UI could ship gestures production rejects. The
    // messages are the migration's own, verbatim: parity.test.ts pins them to
    // the SQL so the fake and the database cannot drift apart silently.
    if (!["", "interested", "dismissed", "snoozed"].includes(input.triage)) {
      return { ok: false, kind: "error", message: `invalid triage value: ${input.triage}` };
    }
    if (input.triage === "snoozed" && input.snoozeUntil == null) {
      return { ok: false, kind: "error", message: "snoozed requires a wake date" };
    }

    const current = this.jobsByKey.get(input.postingKey);
    if (!current) {
      return { ok: false, kind: "error", message: `Unknown posting ${input.postingKey}` };
    }
    if (
      input.expectedUpdatedAt !== null &&
      current.updatedAt !== null &&
      input.expectedUpdatedAt !== current.updatedAt
    ) {
      return { ok: false, kind: "conflict", current: { ...current } };
    }

    const updated: JobView = {
      ...current,
      triage: input.triage,
      // Only a snooze keeps its wake date, exactly as app_set_triage writes
      // it — a dismissed row carrying a stale snooze date is a row that
      // reanimates itself.
      snoozeUntil: input.triage === "snoozed" ? input.snoozeUntil ?? null : null,
      updatedAt: new Date(
        new Date(current.updatedAt ?? FIXTURE_NOW).getTime() + 1000,
      ).toISOString(),
    };
    this.jobsByKey.set(updated.key, updated);

    // marking a posting interesting creates a queued application, exactly as
    // the real triage command does
    if (input.triage === "interested" && !this.apps.some((a) => a.postingKey === updated.key)) {
      this.apps.push({
        id: Math.max(0, ...this.apps.map((a) => a.id)) + 1,
        postingKey: updated.key,
        company: updated.company,
        title: updated.title,
        url: updated.url,
        status: "Queued",
        // A bot created it, so the bots may keep advancing it. This is the
        // default the column has in 0001 and the state acceptance criterion 11
        // depends on: an un-triage removes a still-`Queued` row precisely
        // because nothing human has claimed it.
        statusActor: "system",
        suggestedStatus: null,
        evidence: null,
        appliedDate: null,
        nextAction: null,
        nextActionDate: null,
        notes: null,
        noteCount: 0,
        latestNote: null,
        postingStatus: updated.status,
        updatedAt: updated.updatedAt,
      });
    }
    // Moving AWAY from interested removes the application it created, but only
    // while it is still bot-untouched — exactly as app_set_triage does. This
    // used to fire only on the undo path in both places, so dismissing a role
    // you had marked interested left a live Queued row in the pipeline forever.
    if (input.triage !== "interested") {
      this.apps = this.apps.filter(
        (a) => !(a.postingKey === updated.key && a.status === "Queued"),
      );
    }

    const result: WriteResult = { ok: true, job: { ...updated } };
    this.seenIdempotencyKeys.set(input.idempotencyKey, result);
    return result;
  }

  async setTriageBulk(input: BulkTriageInput): Promise<BulkWriteResult> {
    const replay = this.seenBulkKeys.get(input.idempotencyKey);
    if (replay) return replay;

    // The armed failure fails the BATCH as one unit, in the same position the
    // check holds in setTriage. Left to the per-row apply loop below, the seam
    // fired mid-batch and surfaced as that loop's "should not happen" fallback
    // ("bulk apply failed mid-batch") instead of the armed message — modelling
    // a mid-transaction failure the SQL cannot produce, and hiding the words
    // the arming test asserts (grid-selection.spec.ts, #198). Found by
    // watching that test fail.
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    if (input.postingKeys.length === 0) {
      return { ok: false, kind: "error", message: "no postings selected" };
    }
    if (!["", "interested", "dismissed", "snoozed"].includes(input.triage)) {
      return { ok: false, kind: "error", message: `invalid triage value: ${input.triage}` };
    }
    if (input.triage === "snoozed" && input.snoozeUntil == null) {
      return { ok: false, kind: "error", message: "snoozed requires a wake date" };
    }

    // Validate the WHOLE batch before touching anything, exactly as the
    // transaction does — a conflict on the last row must leave the first row
    // untouched. A fake that applied greedily and bailed on the conflict would
    // model a partial-write the SQL cannot produce, and hide the atomicity bug
    // rather than reproduce it.
    for (let i = 0; i < input.postingKeys.length; i++) {
      const current = this.jobsByKey.get(input.postingKeys[i]);
      if (!current) {
        return { ok: false, kind: "error", message: `no such posting ${input.postingKeys[i]}` };
      }
      const exp = input.expectedUpdatedAt[i] ?? null;
      if (exp !== null && current.updatedAt !== null && exp !== current.updatedAt) {
        return { ok: false, kind: "conflict" };
      }
    }

    // Every row is safe; apply them by threading through the single-row path so
    // the two implementations cannot drift. Each carries its own fresh key so
    // the per-row replay guard does not collapse the batch.
    const jobs: JobView[] = [];
    for (let i = 0; i < input.postingKeys.length; i++) {
      const res = await this.setTriage({
        postingKey: input.postingKeys[i],
        triage: input.triage,
        snoozeUntil: input.snoozeUntil ?? null,
        reason: input.reason,
        idempotencyKey: `${input.idempotencyKey}:${i}`,
        expectedUpdatedAt: input.expectedUpdatedAt[i] ?? null,
      });
      if (!res.ok) {
        // Pre-validated, so this should not happen; if it does, do not report
        // a half-applied batch as success.
        return { ok: false, kind: "error", message: "bulk apply failed mid-batch" };
      }
      jobs.push(res.job);
    }

    const result: BulkWriteResult = { ok: true, jobs };
    this.seenBulkKeys.set(input.idempotencyKey, result);
    return result;
  }

  private seenBulkKeys = new Map<string, BulkWriteResult>();

  // ---- the pipeline (P8) -------------------------------------------------

  private notesByApp = new Map<number, NoteView[]>();
  private seenAppKeys = new Map<string, AppWriteResult>();
  private noteSeq = 0;

  /**
   * Simulate the other device: move the row on without the client knowing.
   *
   * Playwright cannot call a method on a server-side object and a server action
   * cannot be invoked from `page.evaluate`, so the browser-facing channel is the
   * `?demo=conflict:N` search param the pipeline page reads — this is what it
   * calls. A search param rather than a hidden button, because a button in the
   * DOM changes the visual baseline and a param does not.
   */
  simulateExternalEdit(applicationId: number, patch: Partial<ApplicationView> = {}): void {
    const current = this.apps.find((a) => a.id === applicationId);
    if (!current) return;
    Object.assign(current, patch, {
      // The version token MUST move, or there is no conflict to detect — that
      // is the whole mechanism being simulated.
      updatedAt: new Date(
        new Date(current.updatedAt ?? FIXTURE_NOW).getTime() + 60_000,
      ).toISOString(),
    });
  }

  private appById(id: number): ApplicationView | undefined {
    return this.apps.find((a) => a.id === id);
  }

  /**
   * A fresh version token for an application row.
   *
   * `+1s` from the row's OWN previous value, deliberately not `Date.now()`: the
   * demo store is what the visual baselines and the pinned-clock E2Es render, and
   * a real wall clock would make every screenshot a new image. What matters for
   * concurrency is only that the token CHANGES and never repeats, which a
   * monotonic step guarantees more reliably than a clock with millisecond
   * resolution — two writes inside one millisecond would collide.
   *
   * The honest divergence from `now()`: the fake's tokens are not comparable
   * ACROSS rows, so it cannot reproduce a global recency ordering. Nothing depends
   * on one — the pipeline sorts by id (see pipeline-table.tsx) precisely so a row
   * does not move while it is being edited.
   */
  private bumpedApp(a: ApplicationView): string {
    return new Date(new Date(a.updatedAt ?? FIXTURE_NOW).getTime() + 1000).toISOString();
  }

  /** Recompute the derived note fields, exactly as `app_application_row` does. */
  private withNotes(a: ApplicationView): ApplicationView {
    const list = this.notesByApp.get(a.id) ?? [];
    return {
      ...a,
      noteCount: list.length,
      latestNote: list.length ? { ...list[0] } : null,
      // Derived on every read, never stored — the same rule the SQL follows, and
      // the reason matrix row 54 cannot regress: there is no field to go stale.
      postingStatus: this.postingStatusFor(a),
    };
  }

  /**
   * The guard rails every pipeline write shares, in the order the SQL applies
   * them. Returns an error result, or the locked row to write.
   *
   * Ordering is load-bearing and mirrors 0010: replay first (a replay is free
   * even for a gesture that would now be refused), then validation, then
   * existence, then the version check. A fake that checked the version before
   * the replay would report a conflict for a retry that had already landed.
   */
  private beginAppWrite(
    idempotencyKey: string,
    applicationId: number,
    expectedUpdatedAt: string | null,
  ):
    | { replay: AppWriteResult }
    | { error: AppWriteResult }
    | { row: ApplicationView } {
    const replay = this.seenAppKeys.get(idempotencyKey);
    if (replay) return { replay };

    if (!idempotencyKey || idempotencyKey.length > 200) {
      return { error: { ok: false, kind: "error", message: "idempotency key required" } };
    }
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { error: { ok: false, kind: "error", message: msg } };
    }
    const current = this.appById(applicationId);
    if (!current) {
      return {
        error: {
          ok: false,
          kind: "error",
          message: `no such application for this user: ${applicationId}`,
        },
      };
    }
    if (
      expectedUpdatedAt !== null &&
      current.updatedAt !== null &&
      expectedUpdatedAt !== current.updatedAt
    ) {
      return {
        error: { ok: false, kind: "conflict", current: this.withNotes(current) },
      };
    }
    return { row: current };
  }

  private settleApp(key: string, row: ApplicationView): AppWriteResult {
    const result: AppWriteResult = { ok: true, application: this.withNotes(row) };
    this.seenAppKeys.set(key, result);
    return result;
  }

  private appendNote(applicationId: number, body: string, author = "user"): void {
    const list = this.notesByApp.get(applicationId) ?? [];
    // Newest first, which is both the read order and what `latestNote` takes.
    list.unshift({
      id: ++this.noteSeq + 5000,
      body,
      author,
      createdAt: new Date(new Date(FIXTURE_NOW).getTime() + this.noteSeq * 1000).toISOString(),
    });
    this.notesByApp.set(applicationId, list);
  }

  async notes(applicationId: number): Promise<NoteView[]> {
    return (this.notesByApp.get(applicationId) ?? []).map((n) => ({ ...n }));
  }

  async setStatus(input: StatusInput): Promise<AppWriteResult> {
    // The migration's own guards, verbatim where they produce a message the UI
    // shows — parity.test.ts pins these strings to the SQL, so the fake and the
    // database cannot drift apart silently.
    const status = blankTrim(input.status);
    const note = blankTrim(input.note ?? "");
    if (!status) {
      return { ok: false, kind: "error", message: "a status is required" };
    }
    if (status.length > 80) {
      return { ok: false, kind: "error", message: "status is too long (max 80 characters)" };
    }
    if (note.length > 4000) {
      return { ok: false, kind: "error", message: "note is too long (max 4000 characters)" };
    }

    const begun = this.beginAppWrite(
      input.idempotencyKey,
      input.applicationId,
      input.expectedUpdatedAt,
    );
    if ("replay" in begun) return begun.replay;
    if ("error" in begun) return begun.error;
    const current = begun.row;

    // A reopen needs a reason. Checked against the row as it IS, not against
    // whatever the client believed — the client's idea of the current status is
    // exactly the thing that may be stale.
    const reopening = isTerminalStatus(current.status) && !isTerminalStatus(status);
    if (reopening && !note) {
      return { ok: false, kind: "error", message: "reopening needs a note saying why" };
    }

    // A gesture that changes nothing writes nothing (0003's rule). Re-selecting
    // a status a BOT set is not a no-op — the human is claiming the row, and the
    // lock is the entire value of that gesture.
    if (current.status === status && current.statusActor === "user" && !note) {
      return this.settleApp(input.idempotencyKey, current);
    }

    Object.assign(current, {
      status,
      statusActor: "user" as const,
      // A human choosing a status answers the suggestion by making it moot.
      suggestedStatus: null,
      updatedAt: this.bumpedApp(current),
    });
    if (note) this.appendNote(current.id, note);
    return this.settleApp(input.idempotencyKey, current);
  }

  async resolveSuggestion(input: SuggestionInput): Promise<AppWriteResult> {
    if (input.decision !== "confirm" && input.decision !== "reject") {
      return {
        ok: false,
        kind: "error",
        message: `invalid decision: ${String(input.decision)}`,
      };
    }
    const begun = this.beginAppWrite(
      input.idempotencyKey,
      input.applicationId,
      input.expectedUpdatedAt,
    );
    if ("replay" in begun) return begun.replay;
    if ("error" in begun) return begun.error;
    const current = begun.row;

    const suggested = blankTrim(current.suggestedStatus ?? "");
    // Nothing to resolve is free, not an error: a second Confirm arriving after
    // the first honestly means "already done", and a double-tap on a slow
    // connection produces exactly that.
    if (!suggested) return this.settleApp(input.idempotencyKey, current);

    if (input.decision === "confirm") {
      Object.assign(current, {
        status: suggested,
        statusActor: "user" as const,   // confirming IS a human decision
        suggestedStatus: null,
        updatedAt: this.bumpedApp(current),
      });
    } else {
      Object.assign(current, {
        suggestedStatus: null,
        // status and statusActor deliberately untouched. Declining one
        // suggestion is not a claim over the row — a later, better-evidenced
        // email should still be able to advance it.
        updatedAt: this.bumpedApp(current),
      });
    }
    return this.settleApp(input.idempotencyKey, current);
  }

  async addNote(input: NoteInput): Promise<AppWriteResult> {
    const body = blankTrim(input.body);
    if (!body) {
      return { ok: false, kind: "error", message: "a note needs something in it" };
    }
    if (body.length > 4000) {
      return { ok: false, kind: "error", message: "note is too long (max 4000 characters)" };
    }
    // No expectedUpdatedAt: a note cannot conflict with anything.
    const begun = this.beginAppWrite(input.idempotencyKey, input.applicationId, null);
    if ("replay" in begun) return begun.replay;
    if ("error" in begun) return begun.error;

    this.appendNote(begun.row.id, body);
    // Deliberately NOT bumping updatedAt: the application row did not change,
    // and bumping it would invalidate every open tab's token and produce a
    // phantom conflict on the next real gesture — for typing a comment.
    return this.settleApp(input.idempotencyKey, begun.row);
  }

  async setNextAction(input: NextActionInput): Promise<AppWriteResult> {
    const text = blankTrim(input.nextAction);
    if (text.length > 500) {
      return {
        ok: false,
        kind: "error",
        message: "next action is too long (max 500 characters)",
      };
    }
    const begun = this.beginAppWrite(
      input.idempotencyKey,
      input.applicationId,
      input.expectedUpdatedAt,
    );
    if ("replay" in begun) return begun.replay;
    if ("error" in begun) return begun.error;
    const current = begun.row;

    const date = input.nextActionDate ?? null;
    // Saved on blur, so this fires constantly on a field nobody edited.
    if ((current.nextAction ?? "") === text && (current.nextActionDate ?? null) === date) {
      return this.settleApp(input.idempotencyKey, current);
    }

    Object.assign(current, {
      nextAction: text || null,
      nextActionDate: date,
      updatedAt: this.bumpedApp(current),
    });
    return this.settleApp(input.idempotencyKey, current);
  }

  // ---- the company universe (P7) ----------------------------------------

  private companiesById = new Map<number, CompanyView>();
  private seenCompanyKeys = new Map<
    string,
    BulkReviewResult | CompanyFlagsResult | ProposeCompaniesResult
  >();
  private companySeq = 900; // above the fixture ids, so a pasted row is distinguishable

  /** The one ordering contract, shared with SupabaseDataSource.companies():
   *  by name ascending, id ascending on a tie. A tie direction left undefined is
   *  the divergence parity.test.ts exists to pin. */
  private static byName(a: CompanyView, b: CompanyView): number {
    return a.name.localeCompare(b.name) || a.id - b.id;
  }

  async companies(): Promise<CompanyView[]> {
    return [...this.companiesById.values()]
      .sort(FixtureDataSource.byName)
      .map((c) => ({ ...c }));
  }

  private bumped(c: CompanyView): string {
    return new Date(new Date(c.updatedAt ?? FIXTURE_NOW).getTime() + 1000).toISOString();
  }

  async setCompanyReviewBulk(input: BulkReviewInput): Promise<BulkReviewResult> {
    const replay = this.seenCompanyKeys.get(input.idempotencyKey) as BulkReviewResult | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    // The migration's own guards, verbatim, so the UI cannot ship a gesture
    // Postgres rejects (parity.test.ts pins these strings to the SQL).
    if (input.companyIds.length === 0) {
      return { ok: false, kind: "error", message: "no companies selected" };
    }
    if (input.companyIds.length > 1000) {
      return { ok: false, kind: "error", message: "too many companies in one batch" };
    }
    if (!["proposed", "approved", "dismissed"].includes(input.reviewState)) {
      return { ok: false, kind: "error", message: `invalid review state: ${input.reviewState}` };
    }
    if (input.expectedUpdatedAt.length !== input.companyIds.length) {
      return { ok: false, kind: "error", message: "version tokens must match the selection" };
    }

    // Validate the WHOLE batch before touching anything, exactly as the
    // transaction does — a conflict on the last row must leave the first row
    // untouched. A fake that applied greedily would model a partial write the
    // SQL cannot produce, and hide the atomicity bug rather than reproduce it.
    for (let i = 0; i < input.companyIds.length; i++) {
      const current = this.companiesById.get(input.companyIds[i]);
      if (!current) {
        return {
          ok: false,
          kind: "error",
          message: `no such company for this user: ${input.companyIds[i]}`,
        };
      }
      const exp = input.expectedUpdatedAt[i] ?? null;
      if (exp !== null && current.updatedAt !== null && exp !== current.updatedAt) {
        return { ok: false, kind: "conflict" };
      }
    }

    const enabled = input.reviewState === "approved";
    const companies: CompanyView[] = [];
    for (const id of input.companyIds) {
      const current = this.companiesById.get(id)!;
      // No-op rows keep their version token, exactly as the SQL does: bumping it
      // would invalidate every other tab's token for a row nothing changed.
      if (current.reviewState === input.reviewState && current.enabled === enabled) {
        companies.push({ ...current });
        continue;
      }
      const updated: CompanyView = {
        ...current,
        reviewState: input.reviewState,
        enabled,
        updatedAt: this.bumped(current),
      };
      this.companiesById.set(id, updated);
      companies.push({ ...updated });
    }

    const result: BulkReviewResult = { ok: true, companies };
    this.seenCompanyKeys.set(input.idempotencyKey, result);
    return result;
  }

  async setCompanyFlags(input: CompanyFlagsInput): Promise<CompanyFlagsResult> {
    const replay = this.seenCompanyKeys.get(input.idempotencyKey) as CompanyFlagsResult | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    const current = this.companiesById.get(input.companyId);
    if (!current) {
      return {
        ok: false,
        kind: "error",
        message: `no such company for this user: ${input.companyId}`,
      };
    }
    if (
      input.expectedUpdatedAt !== null &&
      current.updatedAt !== null &&
      input.expectedUpdatedAt !== current.updatedAt
    ) {
      return { ok: false, kind: "conflict", current: { ...current } };
    }
    // The review gate, reproduced. The SQL refuses this, so a fake that allowed
    // it would let the UI ship a control that puts an unreviewed company into the
    // sweep — the one thing the proposal state exists to prevent.
    if (current.reviewState !== "approved") {
      return {
        ok: false,
        kind: "error",
        message: `company ${input.companyId} is not approved; review it first`,
      };
    }

    if (current.enabled === input.enabled && current.priority === input.priority) {
      const noop: CompanyFlagsResult = { ok: true, company: { ...current } };
      this.seenCompanyKeys.set(input.idempotencyKey, noop);
      return noop;
    }

    const updated: CompanyView = {
      ...current,
      enabled: input.enabled,
      priority: input.priority,
      updatedAt: this.bumped(current),
    };
    this.companiesById.set(updated.id, updated);
    const result: CompanyFlagsResult = { ok: true, company: { ...updated } };
    this.seenCompanyKeys.set(input.idempotencyKey, result);
    return result;
  }

  async proposeCompanies(input: ProposeCompaniesInput): Promise<ProposeCompaniesResult> {
    const replay = this.seenCompanyKeys.get(input.idempotencyKey) as
      | ProposeCompaniesResult
      | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    if (input.names.length === 0) {
      return { ok: false, kind: "error", message: "no company names given" };
    }
    if (input.names.length > 500) {
      return { ok: false, kind: "error", message: "too many companies in one paste (limit 500)" };
    }

    const source = (input.source.trim() || "manual").toLowerCase();
    if (source.length > 40) return { ok: false, kind: "error", message: "source tag too long" };
    // The closed vocabulary 0008's ALLOWED_SOURCES enforces. A fake that accepted
    // any tag would let the UI ship a provenance value production refuses.
    if (!(PROPOSE_SOURCE_TAGS as readonly string[]).includes(source)) {
      return { ok: false, kind: "error", message: `unknown source tag: ${input.source.trim()}` };
    }

    // The SQL's ceiling on the review pile, not just on one paste.
    const pending = [...this.companiesById.values()].filter(
      (c) => c.reviewState === "proposed",
    ).length;
    if (pending >= MAX_PENDING_PROPOSALS) {
      return {
        ok: false,
        kind: "error",
        message:
          `review backlog is full: ${pending} companies already await review ` +
          `(limit ${MAX_PENDING_PROPOSALS}) — review or dismiss some first`,
      };
    }

    const companies: CompanyView[] = [];
    const seen = new Set<string>();
    let added = 0;
    for (const raw of input.names) {
      const name = raw.trim();
      if (!name || name.length > 200) continue; // a blank line in a paste is not an error
      const key = companyNameKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      // Bind to whatever already represents this NORMALIZED name, grounded row
      // first — `app_propose_companies`'s lookup, reproduced.
      //
      // The previous version matched `name.toLowerCase()` AND required ats='' and
      // slug='', which is what the SQL used to do and what made the ghost: the
      // resolver only ever writes rows with a non-empty ats+slug, so a paste of an
      // already-grounded name matched nothing and minted a permanent tier-3
      // duplicate the human then bound to. A fake that reproduced the old key
      // would now be kinder than Postgres in the one direction that matters.
      const existing = [...this.companiesById.values()]
        .filter((c) => companyNameKey(c.name) === key)
        .sort(
          (a, b) =>
            Number(Boolean(b.ats && b.slug)) - Number(Boolean(a.ats && a.slug)) ||
            (a.tier ?? 9) - (b.tier ?? 9) ||
            a.id - b.id,
        )[0];
      if (existing) {
        // Leave the human's decision alone: re-proposing an approved company would
        // pull it back out of the swept set.
        companies.push({ ...existing });
        continue;
      }

      const row: CompanyView = {
        key: String(++this.companySeq),
        id: this.companySeq,
        name,
        ats: "",
        slug: "",
        source,
        // Tier 3 / manual, never 1. Nothing here resolved a board, and claiming a
        // tier this app cannot verify would be a fabricated reliability promise.
        tier: 3,
        resolutionMethod: "manual",
        reviewState: "proposed",
        enabled: false,
        priority: false,
        seeded: false,
        // A pasted name carries no LinkedIn id, exactly as `app_propose_companies`
        // writes it: the API route refuses ats/slug/tier from its caller for the
        // same reason, and an id nobody pasted would be a fabricated fact about a
        // company nobody has looked up.
        linkedinCompanyId: "",
        linkedinIdSource: "",
        // And no domain: nothing has harvested one for a name pasted this instant.
        domain: null,
        updatedAt: new Date(
          new Date(FIXTURE_NOW).getTime() + this.companySeq * 1000,
        ).toISOString(),
        companyUpdatedAt: new Date(
          new Date(FIXTURE_NOW).getTime() + this.companySeq * 1000,
        ).toISOString(),
      };
      this.companiesById.set(row.id, row);
      companies.push({ ...row });
      added++;
    }

    const result: ProposeCompaniesResult = { ok: true, companies, added };
    this.seenCompanyKeys.set(input.idempotencyKey, result);
    return result;
  }

  // ---- quick add (RM-12) --------------------------------------------------

  /**
   * The durable results, WITH the fingerprint each key is scoped to.
   *
   * `app_add_job` is a post-0026 command: `hq_command_replay` compares a
   * `request_hash` over the normalised arguments and raises 22023 when the
   * same key arrives with different ones. A fake that replayed on the key
   * alone would be more forgiving than production in exactly the way this
   * project keeps getting bitten by — a retry-after-edit would quietly answer
   * the UN-edited write's result here while production refuses it, and the
   * surface's fresh-key-on-edit rule (`lib/quickadd/draft.ts`) would be
   * untestable through the only source the tests can drive.
   */
  private seenAddJobKeys = new Map<string, { fp: string; result: AddJobResult }>();

  /** `hq_command_fingerprint`'s array, over the same blank-trimmed values. */
  private static addJobFingerprint(input: AddJobInput): string {
    return JSON.stringify([
      blankTrim(input.key),
      blankTrim(input.url),
      blankTrim(input.company),
      blankTrim(input.title),
    ]);
  }

  /**
   * The pages this fake can "read", by URL substring.
   *
   * Deliberately small and deliberately incomplete. Three postings are
   * readable; everything else comes back unreadable, because the unreadable
   * path is the one that has to work — it is what a LinkedIn link, a login
   * wall, a rate limit and a dead posting all produce, and it is the branch the
   * legacy lane got right and no web surface has ever exercised.
   */
  private static readonly PAGES: ReadonlyArray<readonly [string, string]> = [
    [
      "boards.greenhouse.io/ramp/jobs/4021775",
      "<html><head><title>Product Manager, Risk - Ramp</title></head><body></body></html>",
    ],
    [
      "jobs.lever.co/plaid/",
      '<html><head><meta property="og:title" content="Product Manager, Identity" />' +
        "<title>Plaid</title></head><body></body></html>",
    ],
    [
      "boards.greenhouse.io/ramp/jobs/8814021",
      "<html><head><title>Product Manager, Core Platform - Ramp</title></head></html>",
    ],
  ];

  /**
   * Deliberately does NOT consume `failNext`.
   *
   * `failNextWrite` arms the next WRITE, and a resolve is a read. Letting it
   * fire here would mean an E2E arming a failed add got a failed parse
   * instead — the armed failure swallowed by the step before the one under
   * test, which is how a write-failure test passes while never reaching the
   * write. An unreadable posting is a normal outcome of this method and has
   * its own branch; it is not an error.
   *
   * Also deliberately does NOT carry the Supabase source's resolve rate gate
   * (`lib/quickadd/rate.ts`): that gate bounds user-driven OUTBOUND fetch,
   * and this method's page reads are the in-memory table above. There is no
   * network capability here to bound, and a gated fake would rate-limit the
   * e2e suite's one shared demo user into flake.
   */
  async resolveJobLinks(input: ResolveJobLinksInput): Promise<ResolveJobLinksResult> {
    const links = await resolveJobLinksWith(input.pasted, {
      readPage: async (url) => {
        const hit = FixtureDataSource.PAGES.find(([fragment]) => url.includes(fragment));
        return hit
          ? { html: hit[1], unreadable: null, finalUrl: url }
          : { html: null, unreadable: UNREADABLE_POSTING, finalUrl: url };
      },
      existing: async (key) => {
        const job = this.jobsByKey.get(key);
        return job ? { key: job.key, company: job.company, title: job.title } : null;
      },
    });
    return { ok: true, links };
  }

  /**
   * The write, as `app_add_job` performs it: replay first, then a duplicate
   * verdict that REPORTS rather than inserts, then the row.
   *
   * The duplicate branch returns `ok: true` with `outcome: "duplicate"`. It is
   * not an error — the user asked for a posting to be tracked and it is
   * tracked. Making it an error would put a red toast on the one gesture that
   * did exactly what was asked.
   */
  async addJob(input: AddJobInput): Promise<AddJobResult> {
    const fp = FixtureDataSource.addJobFingerprint(input);
    const seen = this.seenAddJobKeys.get(input.idempotencyKey);
    if (seen) {
      if (seen.fp !== fp) {
        // 0026's message, verbatim, as `app_add_job` would raise it.
        return {
          ok: false,
          kind: "error",
          message: "idempotency key already used by app_add_job with different arguments",
        };
      }
      return seen.result;
    }

    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message };
    }

    const url = blankTrim(input.url);
    const key = blankTrim(input.key);
    if (url === "" && key === "") {
      return { ok: false, kind: "error", message: "a job needs a link or a name" };
    }
    if (key === "") return { ok: false, kind: "error", message: "unkeyable posting" };

    let result: AddJobResult;
    const existing = this.jobsByKey.get(key);
    if (existing) {
      result = { ok: true, outcome: "duplicate", job: { ...existing } };
    } else {
      const now = new Date(FIXTURE_NOW).toISOString();
      const job: JobView = {
        ...blankJobView(key),
        key,
        company: blankTrim(input.company),
        title: blankTrim(input.title),
        url,
        firstSeen: toLocalIsoDate(new Date(FIXTURE_NOW)),
        updatedAt: now,
      };
      this.jobsByKey.set(key, job);
      result = { ok: true, outcome: "added", job };
    }
    this.seenAddJobKeys.set(input.idempotencyKey, { fp, result });
    return result;
  }

  // ---- the referral finder (0013) ---------------------------------------

  private connectionsById = new Map<number, ConnectionView>();
  private seenReferralKeys = new Map<
    string,
    CompanyFlagsResult | ImportConnectionsResult | ClearConnectionsResult
  >();
  private connectionSeq = 9000; // above the fixture ids, so an import is distinguishable

  async setLinkedinCompanyId(input: LinkedinCompanyIdInput): Promise<CompanyFlagsResult> {
    const replay = this.seenReferralKeys.get(input.idempotencyKey) as CompanyFlagsResult | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    const current = this.companiesById.get(input.companyId);
    if (!current) {
      // `app_set_linkedin_company_id`'s door: a caller with no subscription is
      // refused. The fixture store only holds companies this user watches, so
      // "not in the map" IS "not mine" here.
      return {
        ok: false,
        kind: "error",
        message: `no such company for this user: ${input.companyId}`,
      };
    }

    // The SHARED row's token, not the subscription's. A fake that checked
    // `updatedAt` would accept the wrong token and let the UI ship a gesture
    // production conflicts on.
    if (
      input.expectedUpdatedAt !== null &&
      current.companyUpdatedAt !== null &&
      !sameInstant(input.expectedUpdatedAt, current.companyUpdatedAt)
    ) {
      return { ok: false, kind: "conflict", current: { ...current } };
    }

    // The closed set, reproduced verbatim including its ANCHORS. An unanchored
    // test matches the digits inside `javascript:1`, which is the mutant this
    // exists to be red for — and a fake that accepted it would let the UI paste
    // a value Postgres refuses.
    const id = blankTrim(input.linkedinId);
    if (id !== "" && !/^[0-9]{1,20}$/.test(id)) {
      return {
        ok: false,
        kind: "error",
        message: `a LinkedIn company id is digits only (got ${id.slice(0, 60)})`,
      };
    }

    if (current.linkedinCompanyId === id && current.linkedinIdSource === "human") {
      // No-op rows keep their token, exactly as the SQL does: bumping it would
      // invalidate every other tab's token for a row nothing changed.
      //
      // `&& linkedinIdSource === "human"` tracks 0016, and the SQL condition it
      // mirrors is `v_before is distinct from v_id or v_row.linkedin_id_source <>
      // 'human'`. Re-pasting the id a BOT found is not a no-op: it is a person
      // claiming that id, which is what protects it from the next harvest. A fake
      // that treated it as a no-op would let the UI ship a gesture that appears to
      // work in the demo and leaves the row bot-owned in production.
      const noop: CompanyFlagsResult = { ok: true, company: { ...current } };
      this.seenReferralKeys.set(input.idempotencyKey, noop);
      return noop;
    }

    const updated: CompanyView = {
      ...current,
      linkedinCompanyId: id,
      // Every write through this door is a person's, INCLUDING a clear — that is the
      // tombstone the engine door refuses to overwrite (0016).
      linkedinIdSource: "human",
      companyUpdatedAt: new Date(
        new Date(current.companyUpdatedAt ?? FIXTURE_NOW).getTime() + 1000,
      ).toISOString(),
    };
    this.companiesById.set(updated.id, updated);
    const result: CompanyFlagsResult = { ok: true, company: { ...updated } };
    this.seenReferralKeys.set(input.idempotencyKey, result);
    return result;
  }

  async connections(): Promise<ConnectionView[]> {
    // The one ordering contract, shared with `SupabaseDataSource.connections()`:
    // by full name ascending, id ascending on a tie. A tie direction left
    // undefined is the divergence parity.test.ts exists to pin.
    return [...this.connectionsById.values()]
      .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id - b.id)
      .slice(0, CONNECTION_LIST_LIMIT)
      .map((c) => ({ ...c }));
  }

  async importConnections(input: ImportConnectionsInput): Promise<ImportConnectionsResult> {
    const replay = this.seenReferralKeys.get(input.idempotencyKey) as
      | ImportConnectionsResult
      | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    // The migration's own guards, verbatim, so the UI cannot ship a gesture
    // Postgres rejects (parity.test.ts pins these to the SQL).
    if (input.rows.length > MAX_CONNECTION_CHUNK) {
      return {
        ok: false,
        kind: "error",
        message: `too many connections in one call (limit ${MAX_CONNECTION_CHUNK})`,
      };
    }
    const source = blankTrim(input.source).toLowerCase() || "linkedin-export";
    if (!(CONNECTION_SOURCE_TAGS as readonly string[]).includes(source)) {
      return { ok: false, kind: "error", message: `unknown source tag: ${source.slice(0, 60)}` };
    }

    // `hq_connection_rows`, in TypeScript. Every trim goes through `blankTrim`
    // — the mirror of `hq_blank_trim` — because a cell holding one NBSP is blank
    // to Postgres and would be CONTENT to a bare `.trim()`: the exact divergence
    // matrix row 151 records, in the one place it is most likely to recur.
    const named = input.rows
      .map((r) => ({
        fullName: blankTrim(r.fullName).slice(0, 200),
        firstName: blankTrim(r.firstName).slice(0, 100),
        lastName: blankTrim(r.lastName).slice(0, 100),
        company: blankTrim(r.company).slice(0, 200),
        title: blankTrim(r.title).slice(0, 200),
        profileUrl: blankTrim(r.profileUrl).slice(0, 500),
        // ISO or nothing, exactly as the SQL's anchored test does. A reading the
        // parser refused arrives here as null already; anything else is a
        // malformed request and must not become a date.
        connectedOn: /^\d{4}-\d{2}-\d{2}$/.test(blankTrim(r.connectedOn ?? ""))
          ? blankTrim(r.connectedOn ?? "")
          : null,
      }))
      .filter((r) => r.fullName !== "");

    // LAST occurrence wins within a chunk, matching what a sequence of
    // single-row writes would have left behind.
    const byIdent = new Map<string, (typeof named)[number]>();
    for (const r of named) {
      const ident = r.profileUrl
        ? `u:${r.profileUrl.toLowerCase()}`
        : `n:${r.fullName.toLowerCase()}|${companyNameKey(r.company)}`;
      byIdent.set(ident, r);
    }

    // THE PROMOTION PASS, before anything is matched or inserted.
    //
    // The SQL runs this as its own UPDATE between the lock and the two upserts,
    // and the fake did not have it at all — so a URL-bearing line for somebody
    // stored under no URL found nothing, inserted a second row, and reported
    // `{inserted: 1}` where Postgres reports `{updated: 1}` and holds ONE row.
    // The demo and the entire E2E suite therefore minted exactly the permanent
    // duplicate matrix row 229 exists to prevent, in the one scenario the
    // promotion was written for.
    //
    // A fake that is more forgiving than the real thing hides the bug it exists
    // to catch — and this one was worse than forgiving, it was DIFFERENT: the
    // four-number report a person reads did not match production's.
    //
    // Ordered by URL for the SQL's `distinct on` reason: one chunk can carry two
    // lines with two different URLs whose (name, company) normalize the same, and
    // the lowest URL has to win in both implementations or the same file promotes
    // differently in the demo than in production.
    const promotable = [...byIdent.values()]
      .filter((r) => r.profileUrl !== "")
      .sort((a, b) => a.profileUrl.toLowerCase().localeCompare(b.profileUrl.toLowerCase()));
    for (const r of promotable) {
      // The SQL's `not exists`: if that URL is already held, the URL-less row is
      // left alone rather than promoted into a unique violation.
      const urlTaken = [...this.connectionsById.values()].some(
        (c) => c.profileUrl.toLowerCase() === r.profileUrl.toLowerCase(),
      );
      if (urlTaken) continue;
      const shadow = [...this.connectionsById.values()].find(
        (c) =>
          c.profileUrl === "" &&
          c.fullName.toLowerCase() === r.fullName.toLowerCase() &&
          c.companyKey === companyNameKey(r.company),
      );
      if (shadow) {
        // Promoted, not deleted-and-reinserted: the stored row may hold a
        // `connectedOn` this line does not, and an import never destroys what
        // the file did not say.
        this.connectionsById.set(shadow.id, { ...shadow, profileUrl: r.profileUrl });
      }
    }

    let inserted = 0;
    let updated = 0;
    for (const [ident, r] of byIdent) {
      const existing = [...this.connectionsById.values()].find((c) =>
        ident.startsWith("u:")
          ? c.profileUrl.toLowerCase() === r.profileUrl.toLowerCase()
          : c.profileUrl === "" &&
            c.fullName.toLowerCase() === r.fullName.toLowerCase() &&
            c.companyKey === companyNameKey(r.company),
      );
      if (existing) {
        // A blank cell means "the file did not say", never "delete what you
        // have" (matrix row 151), so only non-blank values are applied.
        const merged: ConnectionView = {
          ...existing,
          fullName: r.fullName || existing.fullName,
          company: r.company || existing.company,
          companyKey: r.company ? companyNameKey(r.company) : existing.companyKey,
          title: r.title || existing.title,
          connectedOn: r.connectedOn ?? existing.connectedOn,
        };
        this.connectionsById.set(merged.id, merged);
        updated++;
        continue;
      }
      // The `not exists` guard: a URL-less line for somebody who already has a
      // URL-bearing row is not a second person. Without this the two partial
      // indexes leave a gap between them and a monthly re-export mints a
      // permanent duplicate.
      if (!r.profileUrl) {
        const shadowed = [...this.connectionsById.values()].some(
          (c) =>
            c.profileUrl !== "" &&
            c.fullName.toLowerCase() === r.fullName.toLowerCase() &&
            c.companyKey === companyNameKey(r.company),
        );
        if (shadowed) continue;
      }
      const row: ConnectionView = {
        id: ++this.connectionSeq,
        fullName: r.fullName,
        company: r.company,
        companyKey: companyNameKey(r.company),
        title: r.title,
        profileUrl: r.profileUrl,
        connectedOn: r.connectedOn,
      };
      this.connectionsById.set(row.id, row);
      inserted++;
    }

    // The four numbers close on the rows sent, and `deduped` is derived by
    // SUBTRACTION for the SQL's reason: it has to absorb both the same person
    // twice and a line shadowed by an existing URL-bearing row.
    const result: ImportConnectionsResult = {
      ok: true,
      inserted,
      updated,
      skipped: input.rows.length - named.length,
      deduped: named.length - inserted - updated,
    };
    this.seenReferralKeys.set(input.idempotencyKey, result);
    return result;
  }

  async clearConnections(input: ClearConnectionsInput): Promise<ClearConnectionsResult> {
    const replay = this.seenReferralKeys.get(input.idempotencyKey) as
      | ClearConnectionsResult
      | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    const deleted = this.connectionsById.size;
    this.connectionsById.clear();
    const result: ClearConnectionsResult = { ok: true, deleted };
    this.seenReferralKeys.set(input.idempotencyKey, result);
    return result;
  }

  // ---- the warm-intro finder (0020) ---------------------------------------

  private warmById = new Map<string, WarmSearchView>();
  private warmPinsByKey = new Map<string, WarmPinView>();
  private seenWarmKeys = new Map<
    string,
    StartWarmSearchResult | PinWarmIntroResult | UnpinWarmIntroResult
  >();
  private warmPinSeq = 7000;
  /**
   * Armed by `hq_warm_over_cap` (via get-source, `failNextWrite`'s channel), so the
   * over-cap UI state is reachable in one search rather than twenty. The honest 24h
   * count is enforced too — this is the E2E's shortcut, not a replacement for it.
   */
  private forceOverCapNext = false;

  forceWarmOverCap(): void {
    this.forceOverCapNext = true;
  }

  async startWarmSearch(input: StartWarmSearchInput): Promise<StartWarmSearchResult> {
    const replay = this.seenWarmKeys.get(input.idempotencyKey) as StartWarmSearchResult | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    // The cap, charged at insert exactly as `app_start_warm_search` does. Rolling
    // 24h so cancelled/failed runs count — the cap is on SPEND, not success.
    const cap = warmDailyCap();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = [...this.warmById.values()].filter(
      (s) => new Date(s.createdAt ?? 0).getTime() > cutoff,
    ).length;
    if (this.forceOverCapNext || recent >= cap) {
      this.forceOverCapNext = false;
      return { ok: false, kind: "over-cap", message: warmOverCapMessage(cap) };
    }

    const now = new Date().toISOString();
    const search: WarmSearchView = {
      id: crypto.randomUUID(),
      targetKind: input.targetKind,
      postingKey: input.postingKey,
      company: input.company,
      params: { ...input.params },
      overlays: {
        schools: [...(input.overlays?.schools ?? [])],
        pastCompanies: [...(input.overlays?.pastCompanies ?? [])],
      },
      status: "running",
      results: [],
      error: "",
      runs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.warmById.set(search.id, search);
    const result: StartWarmSearchResult = { ok: true, search: { ...search } };
    this.seenWarmKeys.set(input.idempotencyKey, result);
    return result;
  }

  async attachWarmRun(input: AttachWarmRunInput): Promise<WarmSearchByIdResult> {
    const s = this.warmById.get(input.id);
    if (!s) return { ok: false, kind: "missing" };
    // Only a running search takes a handle — a cancel between start and attach keeps
    // 'cancelled', the same one-way guard the RPC has.
    if (s.status === "running") s.runs = input.runs.map((r) => ({ ...r }));
    return { ok: true, search: { ...s } };
  }

  async getWarmSearch(id: string): Promise<WarmSearchView | null> {
    const s = this.warmById.get(id);
    return s ? { ...s } : null;
  }

  async completeWarmSearch(input: CompleteWarmSearchInput): Promise<WarmSearchByIdResult> {
    const s = this.warmById.get(input.id);
    if (!s) return { ok: false, kind: "missing" };
    // One-way: only 'running' becomes 'done'. A completion that races a cancel finds
    // 'cancelled' and returns it unchanged — the cancel wins, results dropped.
    if (s.status === "running") {
      s.status = "done";
      s.results = input.results.map((c) => ({ ...c, signals: [...c.signals] }));
      s.error = "";
      s.updatedAt = new Date().toISOString();
    }
    return { ok: true, search: { ...s } };
  }

  async failWarmSearch(input: FailWarmSearchInput): Promise<WarmSearchByIdResult> {
    const s = this.warmById.get(input.id);
    if (!s) return { ok: false, kind: "missing" };
    if (s.status === "running") {
      s.status = "failed";
      s.error = input.error.slice(0, 500);
      s.updatedAt = new Date().toISOString();
    }
    return { ok: true, search: { ...s } };
  }

  async cancelWarmSearch(id: string): Promise<WarmSearchByIdResult> {
    const s = this.warmById.get(id);
    if (!s) return { ok: false, kind: "missing" };
    // Idempotent: a terminal search is a no-op, never an error.
    if (s.status === "running") {
      s.status = "cancelled";
      s.updatedAt = new Date().toISOString();
    }
    return { ok: true, search: { ...s } };
  }

  async warmPins(): Promise<WarmPinView[]> {
    return [...this.warmPinsByKey.values()]
      .sort((a, b) => a.id - b.id)
      .map((p) => ({ ...p }));
  }

  private warmPinKey(targetKind: string, postingKey: string, company: string, identity: string): string {
    // Per PERSON per target (multi-pin): identity = profile URL, or the name when
    // there is none — the mirror of the SQL generated column + unique index.
    return `${targetKind} ${postingKey} ${companyNameKey(company)} ${identity}`;
  }

  async pinWarmIntro(input: PinWarmIntroInput): Promise<PinWarmIntroResult> {
    const replay = this.seenWarmKeys.get(input.idempotencyKey) as PinWarmIntroResult | undefined;
    if (replay) return replay;

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    // The migration's guards, verbatim: a pin needs a name; a URL, when present,
    // must be a LinkedIn address (a bare name is fully legal).
    const name = blankTrim(input.fullName).slice(0, 200);
    if (name === "") return { ok: false, kind: "error", message: "a pin needs a name" };
    const url = blankTrim(input.profileUrl).slice(0, 500);
    if (url !== "" && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(url)) {
      return { ok: false, kind: "error", message: "a profile link must be a LinkedIn address" };
    }
    const source = input.source === "manual" ? "manual" : "warm";

    const identity = url !== "" ? url.toLowerCase() : name.toLowerCase();
    const key = this.warmPinKey(input.targetKind, input.postingKey, input.company, identity);
    const existing = this.warmPinsByKey.get(key);
    const pin: WarmPinView = {
      id: existing?.id ?? ++this.warmPinSeq,
      targetKind: input.targetKind,
      postingKey: input.postingKey,
      company: input.company,
      companyKey: companyNameKey(input.company),
      fullName: name,
      profileUrl: url,
      headline: blankTrim(input.headline).slice(0, 300),
      source,
      updatedAt: new Date().toISOString(),
    };
    this.warmPinsByKey.set(key, pin);
    const result: PinWarmIntroResult = { ok: true, pin: { ...pin } };
    this.seenWarmKeys.set(input.idempotencyKey, result);
    return result;
  }

  async unpinWarmIntro(input: UnpinWarmIntroInput): Promise<UnpinWarmIntroResult> {
    const replay = this.seenWarmKeys.get(input.idempotencyKey) as UnpinWarmIntroResult | undefined;
    if (replay) return replay;

    let deleted = 0;
    for (const [key, pin] of this.warmPinsByKey) {
      if (pin.id === input.id) {
        this.warmPinsByKey.delete(key);
        deleted = 1;
        break;
      }
    }
    const result: UnpinWarmIntroResult = { ok: true, deleted };
    this.seenWarmKeys.set(input.idempotencyKey, result);
    return result;
  }

  // ---- saved views ------------------------------------------------------

  // ---- the search profile (P10) -------------------------------------------

  /** The `criteria` jsonb, verbatim. `{}` is the never-onboarded sentinel. */
  private profileCriteria: Record<string, unknown>;
  private profileNotify: Record<string, unknown>;
  private profileUpdatedAt: string | null;
  private seenProfileKeys = new Map<string, CommitProfileResult>();
  private profileSeq = 0;

  async profile(): Promise<ProfileView> {
    // The same two calls, in the same order, as `SupabaseDataSource.profile()`.
    // A fake that skipped them would let the mapping drift while every test that
    // drives the fake stayed green.
    return {
      criteria: isOnboarded(this.profileCriteria) ? parseCriteria(this.profileCriteria) : null,
      notify: { ...this.profileNotify },
      updatedAt: this.profileUpdatedAt,
    };
  }

  async previewProfile(input: PreviewProfileInput): Promise<PreviewProfileResult> {
    // Bounded exactly as the SQL bounds it: `least(greatest(p_days, 1), 90)`
    // and a 5,000-row cap. A fake that previews an unbounded corpus is a demo
    // whose numbers production cannot reproduce (matrix row 172's shape) — and
    // the clamp is the SHARED function, so the fake cannot be stricter than
    // production either, which is how the reverse of that bug got in.
    const windowDays = clampWindowDays(input.windowDays);
    const cutoff = new Date(new Date(FIXTURE_NOW).getTime() - windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const corpus = PREVIEW_CORPUS.filter((p) => (p.lastSeen ?? "") >= cutoff).slice(
      0,
      PREVIEW_MAX_ROWS,
    );
    return {
      ok: true,
      preview: computePreview(corpus, parseCriteria(input.criteria), {
        windowDays,
        // The wall clock, not the fixture clock: "computed at" is a distance a
        // person reads against now, and pinning it would make every preview say
        // it was computed last July.
        now: new Date().toISOString(),
      }),
    };
  }

  async commitProfile(input: CommitProfileInput): Promise<CommitProfileResult> {
    const replay = this.seenProfileKeys.get(input.idempotencyKey);
    if (replay) return replay;
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }
    if (input.expectedUpdatedAt !== null && input.expectedUpdatedAt !== this.profileUpdatedAt) {
      return { ok: false, kind: "conflict", current: await this.profile() };
    }

    const criteria = parseCriteria(input.criteria);

    // The preview's promises are RE-VERIFIED here rather than trusted. The plan
    // was built against a read that is already in the past, so every entry is
    // checked against the row as it is now: still untriaged, and the tuple
    // really different. A client that sent a plan touching a decided row
    // changes nothing, which is G8 enforced twice on purpose.
    let restamped = 0;
    const newlyQualified: string[] = [];
    for (const entry of input.regate) {
      const row = this.jobsByKey.get(entry.key);
      if (!row) continue;
      if (row.triage !== "") continue;
      if (row.disposition === entry.disposition && row.dispositionReason === entry.reason) continue;
      // 0002_invariants.sql's `filtered_rows_state_a_reason`. A CHECK violation
      // aborts the whole save, so refuse the entry rather than the transaction.
      if (entry.disposition === "filtered" && !entry.reason) continue;
      const was = row.disposition;
      row.disposition = entry.disposition as Disposition;
      row.dispositionReason = entry.reason;
      row.updatedAt = new Date(new Date(FIXTURE_NOW).getTime() + ++this.profileSeq).toISOString();
      restamped += 1;
      if (entry.disposition === "qualified" && was !== "qualified") newlyQualified.push(entry.key);
    }

    this.profileCriteria = { ...criteria };
    if (input.notify) this.profileNotify = { ...input.notify };
    this.profileUpdatedAt = new Date(
      new Date(FIXTURE_NOW).getTime() + ++this.profileSeq,
    ).toISOString();

    const result: CommitProfileResult = {
      ok: true,
      profile: await this.profile(),
      restamped,
      newlyQualifiedKeys: newlyQualified,
    };
    this.seenProfileKeys.set(input.idempotencyKey, result);
    return result;
  }

  // ---- display preferences (0025) ------------------------------------------
  //
  // Stored in the DATABASE's shape — the `display_`-prefixed column names — and
  // read back through the SAME `toDisplayPrefsView` the Supabase source uses,
  // for matrix row 212's reason: a fake that holds the view model tests the
  // RESULT and never the MAPPING, and an `isOnboarded` mutant survived 383
  // tests exactly that way.

  // No `display_theme` — light mode only (DEC-014). The real column still
  // exists on `profiles`, but the Supabase source neither selects nor writes
  // it, so a fake that carried it would be modelling a value the app can
  // never observe.
  private displayRow: Record<string, unknown> = {
    display_density: "dense",
    display_type_scale: "default",
    display_keyboard_hints: true,
    display_landing_view: "",
    // Null, not a timestamp: no `profiles` row exists until the first write, and
    // "there is nothing here yet" is a state the Supabase source can genuinely
    // return. A fake that started with a token would make every first write send
    // an expectation the real store cannot match.
    display_updated_at: null as string | null,
  };
  private seenDisplayKeys = new Map<string, SetDisplayPrefsResult>();
  private displaySeq = 0;

  async displayPrefs(): Promise<DisplayPrefsView> {
    return toDisplayPrefsView({ ...this.displayRow });
  }

  /**
   * `app_set_display_prefs`, clause for clause.
   *
   * The ORDER is the migration's: the payload is validated BEFORE the replay is
   * looked up, so a retry carrying something the function refuses gets the
   * refusal rather than the stored result (0014's rule, and the reason a
   * replay-first fake would answer "saved" to a request Postgres rejects).
   */
  async setDisplayPrefs(input: SetDisplayPrefsInput): Promise<SetDisplayPrefsResult> {
    if (
      !input.idempotencyKey ||
      blankTrim(input.idempotencyKey) === "" ||
      charLength(input.idempotencyKey) > 200
    ) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }

    // The CHECK constraints and the function's own guards, in the language that
    // calls them. A fake that accepted `density: "cozy"` would let a demo — and
    // every e2e test that drives one — prove a write production refuses.
    const bad =
      (input.density !== undefined && !DENSITIES.includes(input.density)
        ? `unknown density: ${input.density}`
        : "") ||
      (input.typeScale !== undefined && !TYPE_SCALES.includes(input.typeScale)
        ? `unknown type scale: ${input.typeScale}`
        : "") ||
      (input.landingView !== undefined && charLength(input.landingView) > LANDING_VIEW_MAX
        ? `landing view too long: ${charLength(input.landingView)} chars`
        : "");
    if (bad) return { ok: false, kind: "error", message: bad };

    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    const replay = this.seenDisplayKeys.get(input.idempotencyKey);
    if (replay) return replay;

    if (
      input.expectedUpdatedAt !== null &&
      input.expectedUpdatedAt !== this.displayRow.display_updated_at
    ) {
      return { ok: false, kind: "conflict", current: await this.displayPrefs() };
    }

    // `??`, matching SQL's `coalesce(p_x, column)`: an OMITTED value leaves its
    // column alone. `||` here would be the bug — `keyboardHints: false` and
    // `landingView: ""` are both falsy and both meaningful.
    const next: Record<string, unknown> = {
      ...this.displayRow,
      display_density: input.density ?? this.displayRow.display_density,
      display_type_scale: input.typeScale ?? this.displayRow.display_type_scale,
      display_keyboard_hints: input.keyboardHints ?? this.displayRow.display_keyboard_hints,
      display_landing_view: input.landingView ?? this.displayRow.display_landing_view,
    };

    // The UPDATE's `is distinct from` guard. A no-op autosave writes nothing:
    // no bumped token, and (in the store) no event. The token holding still is
    // what stops a tab invalidating its own expectation by re-sending what it
    // already has.
    const changed = DISPLAY_COLUMNS.some((c) => next[c] !== this.displayRow[c]);
    if (changed) {
      next.display_updated_at = new Date(
        new Date(FIXTURE_NOW).getTime() + 1000 + ++this.displaySeq,
      ).toISOString();
      this.displayRow = next;
    }

    const result: SetDisplayPrefsResult = {
      ok: true,
      prefs: await this.displayPrefs(),
      changed,
    };
    this.seenDisplayKeys.set(input.idempotencyKey, result);
    return result;
  }

  // ---- the answer library (0014) -------------------------------------------
  //
  // Stored in the DATABASE's shape — snake_case keys, `question_key` computed
  // rather than supplied, `fact` as raw jsonb — and read back through the SAME
  // `toAnswerView` / `toPolicyRuleView` the Supabase source uses. Matrix row 212:
  // a fake that holds the view model tests the RESULT and never the MAPPING, and
  // an `isOnboarded` mutant survived 383 tests exactly that way.

  private answerRows = new Map<string, AnswerRowShape>();
  private ruleRows = new Map<string, PolicyRowShape>();
  private seenApplyKeys = new Map<
    string,
    AnswerWriteResult | PolicyWriteResult | DeletePolicyResult | DeleteAnswerResult
  >();
  private applySeq = 0;

  /** The next version token for a row: its own value plus a second. Never `Date.now()`. */
  private bumpedStamp(prev: string): string {
    return new Date(new Date(prev).getTime() + 1000 + ++this.applySeq).toISOString();
  }

  private ruleKey(topic: string, companyKey: string): string {
    // NUL between the halves: a topic cannot contain one and neither can a
    // company key, so no two distinct pairs can collide on one string.
    return `${topic}\u0000${companyKey}`;
  }

  /**
   * 0017's identity: `(question_key, company_key)`, not the question key alone.
   *
   * Keying on the question alone is what the TABLE did until 0017, and it is the
   * reason a per-company answer had nowhere to live. Same NUL join as `ruleKey`,
   * for the same reason: neither half can contain one.
   */
  private answerKey(question: string, companyKey: string): string {
    return `${question}\u0000${companyKey}`;
  }

  async answers(): Promise<AnswerView[]> {
    return [...this.answerRows.values()]
      .sort(
        (a, b) =>
          a.question_key.localeCompare(b.question_key) ||
          a.company_key.localeCompare(b.company_key),
      )
      .slice(0, APPLY_LIBRARY_LIMIT)
      .map((r) => toAnswerView({ ...r }));
  }

  async policyRules(): Promise<PolicyRuleView[]> {
    return [...this.ruleRows.values()]
      .sort((a, b) => a.topic.localeCompare(b.topic) || a.company_key.localeCompare(b.company_key))
      .slice(0, APPLY_LIBRARY_LIMIT)
      .map((r) => toPolicyRuleView({ ...r }));
  }

  /**
   * `app_upsert_answer`, clause for clause.
   *
   * The ORDER is the migration's, not the convenience one, and one step of it is
   * load-bearing in a way the other fakes here are not: 0014 validates the
   * payload BEFORE it looks for a replay, so a retry carrying something the
   * function refuses gets the refusal rather than the stored result. A
   * replay-first fake would answer "saved" to a request Postgres rejects.
   */
  async upsertAnswer(input: UpsertAnswerInput): Promise<AnswerWriteResult> {
    if (!input.idempotencyKey || blankTrim(input.idempotencyKey) === "" || charLength(input.idempotencyKey) > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    const question = input.question ?? "";
    const answer = input.answer ?? "";
    // CHARACTERS, not UTF-16 units — see `charLength`.
    if (charLength(question) > 2000) {
      return {
        ok: false,
        kind: "error",
        message: `question too long: ${charLength(question)} characters`,
      };
    }
    if (charLength(answer) > 8000) {
      return { ok: false, kind: "error", message: `answer too long: ${charLength(answer)} characters` };
    }
    const companyKey = companyNameKey(input.company ?? "");
    if (charLength(companyKey) > 200) {
      return {
        ok: false,
        kind: "error",
        message: `company too long: ${charLength(companyKey)} characters`,
      };
    }
    if (blankTrim(answer) === "") {
      return { ok: false, kind: "error", message: "answer must not be blank" };
    }
    const key = questionKey(question);
    if (key === "") {
      return { ok: false, kind: "error", message: "question must contain letters or digits" };
    }

    const replay = this.seenApplyKeys.get(input.idempotencyKey) as AnswerWriteResult | undefined;
    if (replay) return replay;

    // The function's own defaults: a blank kind is `freeform`, a blank
    // provenance is `user-entered`.
    const kind = blankTrim(input.kind) === "" ? "freeform" : input.kind;
    const provenance = blankTrim(input.provenance) === "" ? "user-entered" : input.provenance;
    if (!isAnswerKind(kind)) {
      // What Postgres itself answers, verbatim shape — the UI has to handle the
      // real string, not a friendlier invention.
      return {
        ok: false,
        kind: "error",
        message: 'new row for relation "answers" violates check constraint "answers_kind_is_known"',
      };
    }

    const now = new Date(new Date(FIXTURE_NOW).getTime() + ++this.applySeq).toISOString();
    const rowKey = this.answerKey(key, companyKey);
    const existing = this.answerRows.get(rowKey);

    if (!existing) {
      const row: AnswerRowShape = {
        question,
        question_key: key,
        company_key: companyKey,
        answer,
        declined: input.declined === true,
        kind,
        // The TRIGGER's stamp, and the whole reason there is no parameter for
        // it: a signed-in session writes `user`, and this fake only ever models
        // a signed-in session. A `service` row can only be SEEDED.
        //
        // It is also what makes `declined` safe to take from a caller:
        // `answers_declined_is_human_authored` refuses the flag on any row this
        // stamp did not mark `user`, so the fake's "always a session" model and
        // the constraint agree on every row either can produce.
        authored_by: "user",
        provenance,
        confirmed_at: provenance === "confirmed" ? now : null,
        updated_at: now,
      };
      this.answerRows.set(rowKey, row);
      const result: AnswerWriteResult = { ok: true, answer: toAnswerView({ ...row }), created: true };
      this.seenApplyKeys.set(input.idempotencyKey, result);
      return result;
    }

    // Compared as INSTANTS, never as text: `p_expected_updated_at` is declared
    // timestamptz, and one moment has three renderings (matrix rows 146, 168).
    if (input.expectedUpdatedAt !== null && !sameInstant(existing.updated_at, input.expectedUpdatedAt)) {
      return { ok: false, kind: "conflict", current: toAnswerView({ ...existing }) };
    }

    // `hq_authorship_guard`'s advisory half. It guards a caller-supplied column
    // and cannot refuse a dishonest write; it is here because the surface reads
    // that column and a real UI does make this mistake.
    if (
      (existing.provenance === "user-entered" || existing.provenance === "confirmed") &&
      provenance === "suggested"
    ) {
      return {
        ok: false,
        kind: "error",
        message: "a suggested answer may not overwrite one the user entered",
      };
    }

    existing.question = question;
    existing.answer = answer;
    // Overwritten, never OR-ed: somebody who declines and then changes their
    // mind must not be stuck with the flag, and 0017's UPDATE sets the column
    // unconditionally for the same reason.
    existing.declined = input.declined === true;
    existing.kind = kind;
    existing.provenance = provenance;
    // Confirmation is a MOMENT, not a flag a later edit inherits.
    if (provenance === "confirmed") existing.confirmed_at = now;
    existing.updated_at = this.bumpedStamp(existing.updated_at);

    const result: AnswerWriteResult = {
      ok: true,
      answer: toAnswerView({ ...existing }),
      created: false,
    };
    this.seenApplyKeys.set(input.idempotencyKey, result);
    return result;
  }

  /**
   * `app_delete_answer`. Idempotent by RESULT, not by effect — the same rule
   * `deletePolicyRule` follows, and for the same reason: a second tap on a flaky
   * connection must not be told it did nothing when the first one did.
   */
  async deleteAnswer(input: DeleteAnswerInput): Promise<DeleteAnswerResult> {
    if (!input.idempotencyKey || blankTrim(input.idempotencyKey) === "" || charLength(input.idempotencyKey) > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }
    const key = questionKey(input.question ?? "");
    if (key === "") {
      return { ok: false, kind: "error", message: "question must contain letters or digits" };
    }
    const replay = this.seenApplyKeys.get(input.idempotencyKey) as DeleteAnswerResult | undefined;
    if (replay) return replay;

    const deleted = this.answerRows.delete(
      this.answerKey(key, companyNameKey(input.company ?? "")),
    );
    const result: DeleteAnswerResult = { ok: true, deleted };
    this.seenApplyKeys.set(input.idempotencyKey, result);
    return result;
  }

  /** `app_set_policy_rule`, in the same order, with the same refusals. */
  async setPolicyRule(input: SetPolicyRuleInput): Promise<PolicyWriteResult> {
    if (!input.idempotencyKey || blankTrim(input.idempotencyKey) === "" || charLength(input.idempotencyKey) > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }

    const fact = input.fact as unknown;
    if (fact === null || typeof fact !== "object" || Array.isArray(fact)) {
      return { ok: false, kind: "error", message: "fact must be an object" };
    }
    // Text bytes against a bound BELOW the store's, because jsonb's binary form
    // is bigger than its text and a fake that is kinder near a boundary is the
    // failure this file's parity tests exist for. See `MAX_FACT_TEXT_BYTES`.
    const factBytes = new TextEncoder().encode(JSON.stringify(fact)).length;
    if (factBytes > MAX_FACT_TEXT_BYTES) {
      return { ok: false, kind: "error", message: `fact too large: ${factBytes} bytes` };
    }
    const note = input.note ?? "";
    if (charLength(note) > 2000) {
      return { ok: false, kind: "error", message: `note too long: ${charLength(note)} characters` };
    }
    const companyKey = companyNameKey(input.company ?? "");
    if (charLength(companyKey) > 200) {
      return {
        ok: false,
        kind: "error",
        message: `company too long: ${charLength(companyKey)} characters`,
      };
    }

    const replay = this.seenApplyKeys.get(input.idempotencyKey) as PolicyWriteResult | undefined;
    if (replay) return replay;

    const topic = blankTrim(input.topic ?? "");
    if (!POLICY_TOPIC_SET.has(topic)) {
      return {
        ok: false,
        kind: "error",
        message:
          'new row for relation "answer_policies" violates check constraint "answer_policies_topic_is_known"',
      };
    }
    // The SHAPE check. This side is deliberately the stricter of the two on
    // `countries` and `date` — see `lib/apply/views.ts` — so a rule this fake
    // accepts is always one Postgres accepts, never the other way round.
    if (parseSituationFact(fact) === null) {
      return {
        ok: false,
        kind: "error",
        message:
          'new row for relation "answer_policies" violates check constraint "answer_policies_fact_is_wellformed"',
      };
    }

    const provenance = blankTrim(input.provenance) === "" ? "user-entered" : input.provenance;
    const now = new Date(new Date(FIXTURE_NOW).getTime() + ++this.applySeq).toISOString();
    const key = this.ruleKey(topic, companyKey);
    const existing = this.ruleRows.get(key);

    if (!existing) {
      const row: PolicyRowShape = {
        topic,
        company_key: companyKey,
        fact,
        provenance,
        // The trigger's stamp again. `answer_policies_knockouts_are_human_authored`
        // refuses a knockout rule whose `authored_by` is not `user`, which is
        // unreachable from any UI write for exactly this reason — it exists to
        // stop a service-role INSERT, not this caller.
        authored_by: "user",
        note,
        enabled: input.enabled !== false,
        updated_at: now,
      };
      this.ruleRows.set(key, row);
      const result: PolicyWriteResult = {
        ok: true,
        rule: toPolicyRuleView({ ...row }),
        created: true,
      };
      this.seenApplyKeys.set(input.idempotencyKey, result);
      return result;
    }

    if (input.expectedUpdatedAt !== null && !sameInstant(existing.updated_at, input.expectedUpdatedAt)) {
      return { ok: false, kind: "conflict", current: toPolicyRuleView({ ...existing }) };
    }
    if (
      (existing.provenance === "user-entered" || existing.provenance === "confirmed") &&
      provenance === "suggested"
    ) {
      return {
        ok: false,
        kind: "error",
        message: "a suggested answer may not overwrite one the user entered",
      };
    }

    existing.fact = fact;
    existing.provenance = provenance;
    existing.note = note;
    existing.enabled = input.enabled !== false;
    existing.updated_at = this.bumpedStamp(existing.updated_at);

    const result: PolicyWriteResult = {
      ok: true,
      rule: toPolicyRuleView({ ...existing }),
      created: false,
    };
    this.seenApplyKeys.set(input.idempotencyKey, result);
    return result;
  }

  /**
   * `app_delete_policy_rule`. Idempotent by RESULT, not by effect: a replay of a
   * real delete answers `true` forever after, and a first delete of a rule that
   * was never there answers `false`.
   */
  async deletePolicyRule(input: DeletePolicyRuleInput): Promise<DeletePolicyResult> {
    if (!input.idempotencyKey || blankTrim(input.idempotencyKey) === "" || charLength(input.idempotencyKey) > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message: msg };
    }
    const replay = this.seenApplyKeys.get(input.idempotencyKey) as DeletePolicyResult | undefined;
    if (replay) return replay;

    const topic = blankTrim(input.topic ?? "");
    const companyKey = companyNameKey(input.company ?? "");
    const deleted = this.ruleRows.delete(this.ruleKey(topic, companyKey));
    const result: DeletePolicyResult = { ok: true, deleted };
    this.seenApplyKeys.set(input.idempotencyKey, result);
    return result;
  }

  private views: SavedView[] = [];
  private seenViewKeys = new Map<string, SaveViewResult | DeleteViewResult>();
  private viewSeq = 0;

  async savedViews(surface: string): Promise<SavedView[]> {
    return this.views.filter((v) => v.surface === surface).map((v) => ({ ...v }));
  }

  async saveView(input: SaveViewInput): Promise<SaveViewResult> {
    const replay = this.seenViewKeys.get(input.idempotencyKey) as SaveViewResult | undefined;
    if (replay) return replay;

    const name = input.name.trim();
    // The DB's own guards, reproduced — a fake that accepted a nameless or
    // duplicate view would let the UI ship writes Postgres rejects.
    if (!name) return { ok: false, kind: "error", message: "a view needs a name" };
    const clash = this.views.find(
      (v) =>
        v.surface === input.surface &&
        v.id !== input.id &&
        v.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) return { ok: false, kind: "error", message: `a view named "${name}" already exists` };

    // Setting this default clears the others first, exactly as app_save_view
    // does — otherwise two rows claim the landing view.
    if (input.isDefault) {
      for (const v of this.views) {
        if (v.surface === input.surface && v.id !== input.id) v.isDefault = false;
      }
    }

    let row: SavedView;
    if (input.id === null) {
      row = {
        id: `view-${++this.viewSeq}`,
        surface: input.surface,
        name,
        state: input.state,
        isDefault: input.isDefault,
        updatedAt: new Date(new Date(FIXTURE_NOW).getTime() + this.viewSeq * 1000).toISOString(),
      };
      this.views.push(row);
    } else {
      const existing = this.views.find((v) => v.id === input.id);
      if (!existing) return { ok: false, kind: "error", message: `no such view: ${input.id}` };
      if (
        input.expectedUpdatedAt !== null &&
        existing.updatedAt !== null &&
        input.expectedUpdatedAt !== existing.updatedAt
      ) {
        return { ok: false, kind: "conflict" };
      }
      existing.name = name;
      existing.state = input.state;
      existing.isDefault = input.isDefault;
      existing.updatedAt = new Date(
        new Date(existing.updatedAt ?? FIXTURE_NOW).getTime() + 1000,
      ).toISOString();
      row = existing;
    }

    const result: SaveViewResult = { ok: true, view: { ...row } };
    this.seenViewKeys.set(input.idempotencyKey, result);
    return result;
  }

  async deleteView(input: DeleteViewInput): Promise<DeleteViewResult> {
    const replay = this.seenViewKeys.get(input.idempotencyKey) as DeleteViewResult | undefined;
    if (replay) return replay;
    const before = this.views.length;
    this.views = this.views.filter((v) => v.id !== input.id);
    const result: DeleteViewResult =
      this.views.length < before
        ? { ok: true }
        : { ok: false, kind: "error", message: `no such view: ${input.id}` };
    this.seenViewKeys.set(input.idempotencyKey, result);
    return result;
  }

  // ============================================================ import (P9)
  //
  // The fake models the failure modes, not the happy path — and for import the
  // failure modes ARE the feature. Every one of these is reproduced from
  // `db/migrations/0011_import.sql` rather than approximated, because the E2E
  // journey runs entirely against this store and a fake that quietly succeeds
  // where Postgres refuses would let the wizard ship broken:
  //
  //   * a stale `hq_version` is an UNRESOLVED conflict, and commit REFUSES while
  //     one exists (AC 23 — the database is the enforcement point, so the fake
  //     has to enforce it too or the UI's blocked state is never exercised)
  //   * a status a human chose is not overwritten by a bulk import, and the
  //     skip is reported rather than silent
  //   * a round trip carrying the row's own token DOES write it, and claims it
  //   * a blank cell never erases a value
  //   * a repeated (company, title) is SKIPPED, not duplicated — 0002's partial
  //     unique index, which is half the mechanism behind AC 20
  //   * undo refuses past its window, is idempotent on its key, and keeps rows
  //     edited since the import
  //   * `failNextWrite()` reaches the commit path, so a mid-batch failure is
  //     drivable from a test rather than argued about

  private batches = new Map<string, ImportBatchView>();
  private importRows = new Map<string, FixtureImportRow[]>();
  private reports = new Map<string, ImportColumnReportView[]>();
  private seenImportKeys = new Map<string, unknown>();
  private batchSeq = 0;

  /**
   * The fixture clock, for values only ever compared for EQUALITY.
   *
   * Application version tokens live here: nothing measures the distance between
   * two of them, so a pinned clock keeps them deterministic and keeps the visual
   * baselines honest.
   */
  private importNow(offsetMs = 0): string {
    return new Date(new Date(FIXTURE_NOW).getTime() + this.batchSeq * 1000 + offsetMs).toISOString();
  }

  /**
   * The WALL clock, for the batch's own timestamps — and this distinction is a
   * bug the parity test caught rather than a preference.
   *
   * `undo_expires_at` is `committed_at + 24 hours` and it is compared against
   * NOW. Stamped from the pinned fixture clock (2026-07-20) it is already in the
   * past on any real day, so a batch committed thirty seconds ago answered "the
   * 24-hour undo window closed on the 21st" — in demo mode, which is the mode the
   * owner is shown and the entire E2E suite runs in. Every undo test failed, and
   * the failure was the FAKE's, not the feature's.
   *
   * Postgres stamps these with `now()`, so the wall clock is the faithful mirror.
   * Nothing pins a pixel to them: the wizard shows a relative age, and no visual
   * baseline covers this surface.
   */
  private importWallClock(offsetMs = 0): string {
    return new Date(Date.now() + offsetMs).toISOString();
  }

  private batchOr(batchId: string): ImportBatchView | undefined {
    return this.batches.get(batchId);
  }

  private bumpBatch(b: ImportBatchView): void {
    b.updatedAt = new Date(new Date(b.updatedAt ?? FIXTURE_NOW).getTime() + 1000).toISOString();
  }

  private replayImport<T>(key: string): T | undefined {
    return this.seenImportKeys.get(key) as T | undefined;
  }

  private settleImport<T>(key: string, result: T): T {
    this.seenImportKeys.set(key, result);
    return result;
  }

  /** `IMPORT_LIST_LIMIT` rows, newest first — the same bound `SupabaseDataSource` asks
   *  PostgREST for. Unbounded here, a demo with 60 batches rendered a list the real
   *  app truncates at 25, which is a list nobody can reproduce. */
  async imports(): Promise<ImportBatchView[]> {
    return [...this.batches.values()]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, IMPORT_LIST_LIMIT)
      .map((b) => ({ ...b, mapping: { ...b.mapping } }));
  }

  async importBatch(
    batchId: string,
  ): Promise<{ batch: ImportBatchView; rows: ImportRowView[] } | null> {
    const batch = this.batchOr(batchId);
    if (!batch) return null;
    return {
      batch: { ...batch, mapping: { ...batch.mapping } },
      rows: (this.importRows.get(batchId) ?? []).map((r) => ({ ...r })),
    };
  }

  async createImport(input: CreateImportInput): Promise<ImportBatchResult> {
    const replay = this.replayImport<ImportBatchResult>(input.idempotencyKey);
    if (replay) return replay;
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    if (!["xlsx", "csv", "paste"].includes(input.sourceKind)) {
      return {
        ok: false,
        kind: "error",
        message: `unsupported import source: ${input.sourceKind}`,
      };
    }
    // The same cap the migration carries, with the same words. A fake that
    // accepted 6,000 rows would let the UI ship with no message for the case.
    if (input.rowCount > 5000) {
      return {
        ok: false,
        kind: "error",
        message: `that file has ${input.rowCount} rows; the limit is 5000 — split it and import in parts`,
      };
    }
    const open = [...this.batches.values()].filter((b) =>
      ["uploaded", "mapped", "previewed", "committing"].includes(b.state),
    ).length;
    if (open >= 20) {
      return {
        ok: false,
        kind: "error",
        message: `you have ${open} imports still in progress (limit 20) — finish or discard one first`,
      };
    }

    this.batchSeq += 1;
    const batch: ImportBatchView = {
      id: `batch-${this.batchSeq}`,
      state: "uploaded",
      filename: blankTrim(input.filename),
      sourceKind: input.sourceKind,
      contentHash: input.contentHash,
      rowCount: input.rowCount,
      committedCount: 0,
      stagedCount: 0,
      mapping: { ...EMPTY_IMPORT_MAPPING },
      createdAt: this.importWallClock(),
      updatedAt: this.importWallClock(),
      committedAt: null,
      undoExpiresAt: null,
    };
    this.batches.set(batch.id, batch);
    this.importRows.set(batch.id, []);
    return this.settleImport(input.idempotencyKey, { ok: true, batch: { ...batch } });
  }

  async stageImportRows(input: StageImportInput): Promise<StageImportResult> {
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    if (batch.state !== "uploaded") {
      return {
        ok: false,
        kind: "error",
        message: `this import is already past staging (state ${batch.state})`,
      };
    }
    const rows = this.importRows.get(input.batchId) ?? [];
    const seen = new Set(rows.map((r) => r.rowNumber));
    let staged = 0;
    for (const incoming of input.rows) {
      // Idempotent per row number, exactly as `on conflict (batch_id,
      // row_number) do nothing` is: a retried chunk is the same rows.
      if (incoming.rowNumber <= 0 || seen.has(incoming.rowNumber)) continue;
      seen.add(incoming.rowNumber);
      staged += 1;
      rows.push({
        rowNumber: incoming.rowNumber,
        raw: { ...incoming.raw },
        mapped: {},
        jobKey: "",
        keyStrength: "none",
        matchKind: "new",
        matchedApplicationId: null,
        conflictState: "none",
        conflict: {},
        choices: {},
        included: true,
        outcome: "pending",
        notice: "",
        error: "",
      });
    }
    rows.sort((a, b) => a.rowNumber - b.rowNumber);
    this.importRows.set(input.batchId, rows);
    batch.stagedCount = rows.length;
    batch.rowCount = rows.length;
    return { ok: true, staged, total: rows.length };
  }

  async setImportMapping(input: SetImportMappingInput): Promise<ImportBatchResult> {
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    if (!["uploaded", "mapped", "previewed"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: `this import can no longer be re-mapped (state ${batch.state})`,
      };
    }
    const rows = this.importRows.get(input.batchId) ?? [];
    const byNumber = new Map(rows.map((r) => [r.rowNumber, r]));
    for (const incoming of input.rows) {
      const row = byNumber.get(incoming.rowNumber);
      if (!row) continue;
      row.mapped = { ...incoming.mapped };
      row.jobKey = incoming.jobKey.slice(0, 400);
      row.keyStrength = incoming.keyStrength;
      // A new mapping invalidates every conclusion drawn from the old one.
      row.matchKind = "new";
      row.matchedApplicationId = null;
      row.conflictState = "none";
      row.conflict = {};
      row.choices = {};
      row.notice = "";
      row.mappedAt = true;
    }

    if (input.final) {
      if (
        input.expectedUpdatedAt !== null &&
        batch.updatedAt !== null &&
        input.expectedUpdatedAt !== batch.updatedAt
      ) {
        return { ok: false, kind: "conflict" };
      }
      const unmapped = rows.filter((r) => !r.mappedAt).length;
      if (unmapped > 0) {
        return {
          ok: false,
          kind: "error",
          message: `${unmapped} staged rows never got a mapping — the import would commit blanks`,
        };
      }
      batch.mapping = { ...input.mapping };
      batch.state = "mapped";
      this.reports.set(
        input.batchId,
        (this.reports.get(input.batchId) ?? [])
          .filter((r) => r.disposition !== "unmapped" && r.disposition !== "unknown-column")
          .concat(
            input.mapping.unmapped.map((u) => ({
              column: u.name,
              disposition: u.disposition,
              rows: batch.rowCount,
              sample: [],
            })),
          ),
      );
      this.bumpBatch(batch);
    }
    return { ok: true, batch: { ...batch } };
  }

  async previewImport(batchId: string): Promise<ImportPreviewResult> {
    const batch = this.batchOr(batchId);
    if (!batch) return { ok: false, kind: "error", message: `no such import: ${batchId}` };
    if (!["mapped", "previewed"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: `this import is not ready to preview (state ${batch.state})`,
      };
    }
    const rows = this.importRows.get(batchId) ?? [];

    // Order matters and mirrors the SQL exactly: a clean slate, then duplicates
    // (so the FIRST occurrence keeps whatever the later rules decide), then the
    // round trip, then strong keys, then weak ones.
    for (const r of rows) {
      r.matchKind = "new";
      r.matchedApplicationId = null;
      r.conflictState = "none";
      r.conflict = {};
      r.notice = "";
    }

    const firstByKey = new Map<string, number>();
    for (const r of rows) {
      if (!r.jobKey) continue;
      const first = firstByKey.get(r.jobKey);
      if (first === undefined) firstByKey.set(r.jobKey, r.rowNumber);
      else {
        r.matchKind = "duplicate-in-file";
        r.notice = "the same job appears earlier in this file; the first row wins";
      }
    }

    for (const r of rows) {
      if (r.matchKind === "duplicate-in-file") continue;
      const hqId = blankTrim(r.mapped.hqId);
      const company = companyNameKey(r.mapped.company ?? "");
      const title = companyNameKey(r.mapped.title ?? "");

      if (hqId) {
        const match = this.apps.find((a) => String(a.id) === hqId);
        if (match) {
          r.matchKind = "round-trip";
          r.matchedApplicationId = match.id;
        } else {
          // An id that resolves to nothing resolves to NOTHING — never to
          // another row. Somebody else's export lands here.
          r.notice =
            "the hq_id in this row matched none of your applications, so it was treated as a new row";
        }
      }

      if (r.matchKind === "new" && r.keyStrength === "strong" && r.jobKey) {
        const byKey = this.apps.find((a) => a.postingKey === r.jobKey);
        if (byKey) {
          r.matchKind = "matches-existing";
          r.matchedApplicationId = byKey.id;
        }
      }
      if (r.matchKind === "new" && r.keyStrength === "strong" && company && title) {
        // Restricted to rows with NO posting key, as the SQL is: that is what
        // stops the fallback reaching a row that came from a real triage.
        const byName = this.apps
          .filter(
            (a) =>
              a.postingKey === null &&
              companyNameKey(a.company) === company &&
              companyNameKey(a.title) === title,
          )
          .sort((a, b) => a.id - b.id)[0];
        if (byName) {
          r.matchKind = "matches-existing";
          r.matchedApplicationId = byName.id;
        }
      }
      if (r.matchKind === "new" && r.keyStrength === "weak" && company && title) {
        const lookalike = this.apps
          .filter(
            (a) =>
              companyNameKey(a.company) === company && companyNameKey(a.title) === title,
          )
          .sort((a, b) => a.id - b.id)[0];
        if (lookalike) {
          // A SUGGESTION. `isStrong()` is the only merge authorisation there is,
          // and a `norm-` key is a normalised guess at a company and a title.
          r.matchKind = "suggestion";
          r.matchedApplicationId = lookalike.id;
          r.notice =
            "looks like an application you already have, but the file gives no way to prove it — imported separately and flagged";
        }
      }
      if (r.matchKind === "new" && r.keyStrength !== "strong") r.matchKind = "unkeyable";
    }

    // Round-trip conflicts, per changed cell.
    for (const r of rows) {
      if (r.matchKind !== "round-trip") continue;
      const token = blankTrim(r.mapped.hqVersion);
      if (!token) continue;
      const app = this.appById(r.matchedApplicationId ?? -1);
      if (!app) continue;
      // Compared as an INSTANT, not as a string: the same moment renders
      // several ways and a string compare would call every row stale.
      const theirs = new Date(token).getTime();
      const mineTs = new Date(app.updatedAt ?? 0).getTime();
      if (Number.isFinite(theirs) && !Number.isNaN(theirs) && theirs === mineTs) continue;
      const diff: Record<string, { mine: string; theirs: string }> = {};
      for (const column of WRITABLE_COLUMNS) {
        const t = blankTrim(r.mapped[MAPPED_KEY[column]]);
        if (!t) continue;
        const m = this.writableValue(app, column);
        // The marker compared by its EFFECT, as the SQL does: "make this
        // empty" against an already-empty field is no conflict at all, while
        // `theirs` keeps the RAW marker so the resolver shows the gesture.
        const effective = isUnsetMarker(t) && isClearableColumn(column) ? "" : t;
        if (effective !== m) diff[column] = { mine: m, theirs: t };
      }
      if (Object.keys(diff).length > 0) {
        r.conflictState = "unresolved";
        r.conflict = diff;
      }
    }

    batch.state = "previewed";
    this.bumpBatch(batch);
    const counts: ImportCounts = {};
    for (const r of rows) counts[r.matchKind] = (counts[r.matchKind] ?? 0) + 1;
    return {
      ok: true,
      batch: { ...batch },
      counts,
      unresolved: rows.filter((r) => r.conflictState === "unresolved").length,
    };
  }

  /** One writable column's current value, as a string, for the conflict diff. */
  private writableValue(app: ApplicationView, column: string): string {
    switch (column) {
      case "status":
        return app.status;
      case "notes":
        return app.notes ?? "";
      case "next_action":
        return app.nextAction ?? "";
      case "next_action_date":
        return app.nextActionDate ?? "";
      case "applied_date":
        return app.appliedDate ?? "";
      default:
        return "";
    }
  }

  async resolveImportRow(input: ResolveImportRowInput): Promise<ResolveImportRowResult> {
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    if (!["previewed", "mapped"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: `this import is not open for conflict resolution (state ${batch.state})`,
      };
    }
    for (const [column, choice] of Object.entries(input.choices)) {
      if (!isWritableColumn(column)) {
        return {
          ok: false,
          kind: "error",
          message: `column ${column} is not one an import may write`,
        };
      }
      if (choice !== "mine" && choice !== "theirs") {
        return {
          ok: false,
          kind: "error",
          message: `choice for ${column} must be mine or theirs`,
        };
      }
    }
    const rows = this.importRows.get(input.batchId) ?? [];
    const row = rows.find(
      (r) => r.rowNumber === input.rowNumber && r.conflictState === "unresolved",
    );
    if (!row) {
      return {
        ok: false,
        kind: "error",
        message: `row ${input.rowNumber} of this import has no unresolved conflict`,
      };
    }
    row.choices = { ...input.choices };
    row.conflictState = "resolved";
    return {
      ok: true,
      unresolved: rows.filter((r) => r.conflictState === "unresolved").length,
    };
  }

  async setImportRowsIncluded(input: IncludeImportRowsInput): Promise<StageImportResult> {
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    if (!["mapped", "previewed"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: `rows can no longer be excluded (state ${batch.state})`,
      };
    }
    const rows = this.importRows.get(input.batchId) ?? [];
    let n = 0;
    for (const r of rows) {
      if (!input.rowNumbers.includes(r.rowNumber) || r.outcome !== "pending") continue;
      r.included = input.included;
      n += 1;
    }
    return { ok: true, staged: n, total: rows.length };
  }

  async commitImportChunk(input: CommitImportInput): Promise<ImportCommitResult> {
    const replay = this.replayImport<ImportCommitResult>(input.idempotencyKey);
    if (replay) return replay;
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    // Armed failure reaches the commit loop, so "the commit died mid-batch" is
    // drivable from a browser rather than reasoned about (matrix row 31).
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      return { ok: false, kind: "error", message };
    }
    if (batch.state === "committed") {
      // Already done. A lost response and a double-click both look like this,
      // and answering a gesture that worked with a red toast is the version
      // people notice.
      return this.settleImport(input.idempotencyKey, {
        ok: true,
        batch: { ...batch },
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        remaining: 0,
      } as ImportCommitResult);
    }
    if (!["previewed", "committing"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: `this import is not ready to commit (state ${batch.state})`,
      };
    }

    const rows = this.importRows.get(input.batchId) ?? [];
    const unresolved = rows.filter(
      (r) => r.conflictState === "unresolved" && r.included,
    ).length;
    if (unresolved > 0) {
      // AC 23. Enforced here as well as in SQL, or the wizard's blocked state
      // is never exercised by the suite that drives the fake.
      return {
        ok: false,
        kind: "error",
        message: `${unresolved} rows still have unresolved conflicts — resolve them before committing`,
      };
    }

    if (batch.state === "previewed") {
      batch.state = "committing";
      batch.committedAt = batch.committedAt ?? this.importWallClock();
      batch.undoExpiresAt =
        batch.undoExpiresAt ??
        new Date(new Date(batch.committedAt).getTime() + 24 * 3600 * 1000).toISOString();
    }

    // `?? 200`, not `|| 200`, and it matters: the SQL clamps with
    // `least(greatest(coalesce(p_limit, 200), 1), 500)`, so a limit of 0 is
    // coalesced only when NULL and otherwise raised to 1 — one row. `||` treats 0
    // as absent and gave the fake 200. A caller sending 0 therefore saw one row
    // commit in production and the whole batch in the demo, which is precisely the
    // "fake more forgiving than the real thing" shape.
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const pending = rows.filter((r) => r.outcome === "pending" && r.included).slice(0, limit);
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const locked: string[] = [];

    for (const row of pending) {
      /**
       * `blankTrim`, never bare `.trim()`.
       *
       * The SQL reads every mapped cell through `hq_blank_trim`, which also strips
       * the zero-width characters and the exotic separators a spreadsheet is full
       * of. `.trim()` leaves U+200B alone — so a cell holding one zero-width space
       * was BLANK to Postgres and CONTENT to the fake: the fake would overwrite a
       * next action with an invisible character, read a zero-width status as a
       * status, and invent a round-trip conflict on a cell the database considers
       * empty. A fake more forgiving than the real thing hides the bug it exists
       * to catch, and here it was more forgiving in the direction that writes.
       */
      const value = (field: string) => blankTrim(row.mapped[field]);
      let status = value("status").slice(0, 80);
      let note = value("notes").slice(0, 4000);
      let next = value("nextAction").slice(0, 500);
      let nextDate = value("nextActionDate") || null;
      let applied = value("appliedDate") || null;
      const company = value("company");
      const title = value("title");
      const roundTrip =
        row.matchKind === "round-trip" &&
        (value("hqVersion") !== "" || row.conflictState === "resolved");

      // The refusal scan, mirroring the SQL's exactly: a marker in a column it
      // cannot clear fails the ROW by name, never imports the literal. The
      // pairs are the vocabulary `hq_import_mapped_value` translates.
      const marked = (
        [
          ["company", "company"],
          ["title", "title"],
          ["url", "url"],
          ["location", "location"],
          ["status", "status"],
          ["notes", "notes"],
          ["next_action", "nextAction"],
          ["next_action_date", "nextActionDate"],
          ["applied_date", "appliedDate"],
          ["hq_id", "hqId"],
          ["hq_version", "hqVersion"],
        ] as const
      )
        .filter(([column, key]) => !isClearableColumn(column) && isUnsetMarker(value(key)))
        .map(([column]) => column)
        .sort();

      // The clear flags, from the RAW mapped text — the SQL computes them
      // before its date coercion erases the evidence; here the text one is
      // blanked immediately so no later branch writes the literal.
      let clearNext = isUnsetMarker(value("nextAction"));
      let clearNextDate = isUnsetMarker(value("nextActionDate"));
      let clearApplied = isUnsetMarker(value("appliedDate"));
      if (clearNext) next = "";
      if (clearNextDate) nextDate = null;
      if (clearApplied) applied = null;

      if (row.conflictState === "resolved") {
        // FAIL CLOSED, mirroring the SQL exactly (the #236 security finding):
        // a conflicted cell writes only on an explicit 'theirs' — unanswered
        // means 'mine', because a resolved row is exempt from the version
        // re-check and this block is all that stands between a partial resolve
        // and a value somebody edited after the export.
        const keepMine = (column: string) =>
          (column in row.conflict && row.choices[column] !== "theirs") ||
          row.choices[column] === "mine";
        if (keepMine("status")) status = "";
        if (keepMine("notes")) note = "";
        if (keepMine("next_action")) {
          next = "";
          clearNext = false;
        }
        if (keepMine("next_action_date")) {
          nextDate = null;
          clearNextDate = false;
        }
        if (keepMine("applied_date")) {
          applied = null;
          clearApplied = false;
        }
      }

      if (row.matchKind === "duplicate-in-file") {
        row.outcome = "skipped";
        row.error = "skipped: an earlier row in this file is the same job";
        skipped += 1;
        continue;
      }

      // After the duplicate skip (a row that writes nothing has nothing to
      // refuse), before either write path — the SQL's order.
      if (marked.length > 0) {
        row.outcome = "failed";
        row.error = `the unset marker can only clear ${CLEARABLE_COLUMNS.join(", ")} — not ${marked.join(", ")}`;
        failed += 1;
        continue;
      }

      if (
        row.matchedApplicationId !== null &&
        (row.matchKind === "matches-existing" || row.matchKind === "round-trip")
      ) {
        const app = this.appById(row.matchedApplicationId);
        if (!app) {
          row.outcome = "failed";
          row.error = "the application this row matched no longer exists";
          failed += 1;
          continue;
        }
        let writeStatus = status !== "" && status !== app.status;
        // The human lock. A bulk import does not claim it and does not break it;
        // a round trip carrying this row's own token does.
        if (writeStatus && app.statusActor === "user" && !roundTrip) {
          writeStatus = false;
          locked.push(`${app.status} -> ${status}`);
        }
        row.revertBefore = {
          status: app.status,
          statusActor: app.statusActor,
          nextAction: app.nextAction,
          nextActionDate: app.nextActionDate,
          appliedDate: app.appliedDate,
        };
        // What this row ACTUALLY cleared: marker present AND a live value
        // erased. Clearing an already-empty field is a no-op, not a report
        // line. Recorded before the write, which is the last moment the old
        // values exist.
        row.clearedColumns = [
          ...(clearNext && (app.nextAction ?? "") !== "" ? ["nextAction"] : []),
          ...(clearNextDate && app.nextActionDate !== null ? ["nextActionDate"] : []),
          ...(clearApplied && app.appliedDate !== null ? ["appliedDate"] : []),
        ];
        Object.assign(app, {
          status: writeStatus ? status : app.status,
          statusActor: writeStatus && roundTrip ? ("user" as const) : app.statusActor,
          // The marker clears; a blank cell is still "I did not fill this in",
          // never "delete it".
          nextAction: clearNext ? null : next !== "" ? next : app.nextAction,
          nextActionDate: clearNextDate ? null : (nextDate ?? app.nextActionDate),
          appliedDate: clearApplied ? null : (applied ?? app.appliedDate),
          updatedAt: this.bumpedApp(app),
        });
        if (note) this.appendNote(app.id, note, "import");
        row.outcome = "updated";
        row.wroteUpdatedAt = app.updatedAt;
        // A cleared column is deliberately NOT in `wroteColumns` — nothing was
        // imported into it; `clearedColumns` is its account.
        row.wroteColumns = [
          ...(writeStatus ? ["status"] : []),
          ...(note ? ["notes"] : []),
          ...(next !== "" ? ["nextAction"] : []),
          ...(nextDate !== null ? ["nextActionDate"] : []),
          ...(applied !== null ? ["appliedDate"] : []),
        ];
        updated += 1;
        continue;
      }

      if (!company || !title) {
        row.outcome = "failed";
        row.error = "a row needs both a company and a title";
        failed += 1;
        continue;
      }

      // 0002's partial unique index on (user, lower(company), lower(title))
      // where posting_key is null. Reproduced because it is half the mechanism
      // behind AC 20 — without it a re-import would look like it duplicated.
      const collision = this.apps.find(
        (a) =>
          a.postingKey === null &&
          a.company.toLowerCase() === company.toLowerCase() &&
          a.title.toLowerCase() === title.toLowerCase(),
      );
      if (collision) {
        row.outcome = "skipped";
        row.error = "skipped: you already have this company and title";
        skipped += 1;
        continue;
      }

      const id = Math.max(0, ...this.apps.map((a) => a.id)) + 1;
      const app: ApplicationView = {
        id,
        // Only when the sweep has actually seen this posting; the FK refuses
        // anything else, and a fake that set it anyway would hide the
        // name-matching path the second import depends on.
        postingKey: this.jobsByKey.has(row.jobKey) ? row.jobKey : null,
        company: company.slice(0, 200),
        title: title.slice(0, 200),
        url: value("url").slice(0, 2000) || null,
        status: status || "Inbox",
        // NOT 'user'. An import is not a human status gesture.
        statusActor: "system",
        suggestedStatus: null,
        evidence: null,
        appliedDate: applied,
        nextAction: next || null,
        nextActionDate: nextDate,
        notes: null,
        noteCount: 0,
        latestNote: null,
        postingStatus: this.jobsByKey.get(row.jobKey)?.status ?? null,
        updatedAt: this.importNow(1000 + row.rowNumber),
      };
      this.apps.push(app);
      if (note) this.appendNote(id, note, "import");
      row.outcome = "created";
      row.matchedApplicationId = id;
      row.wroteUpdatedAt = app.updatedAt;
      // On the insert path every non-blank value went in by construction. A blank
      // status became "Inbox", which the file did not say, so it is not counted.
      row.wroteColumns = [
        ...(status !== "" ? ["status"] : []),
        ...(note ? ["notes"] : []),
        ...(next !== "" ? ["nextAction"] : []),
        ...(nextDate !== null ? ["nextActionDate"] : []),
        ...(applied !== null ? ["appliedDate"] : []),
      ];
      created += 1;
    }

    // Excluded rows are settled here rather than left pending forever, or the
    // batch could never read as finished.
    for (const r of rows) {
      if (r.outcome === "pending" && !r.included) {
        r.outcome = "skipped";
        r.error = "excluded by you";
      }
    }

    if (locked.length > 0) {
      const list = this.reports.get(input.batchId) ?? [];
      const existing = list.find((x) => x.column === "Status" && x.disposition === "locked");
      if (existing) existing.rows += locked.length;
      else
        list.push({
          column: "Status",
          disposition: "locked",
          rows: locked.length,
          sample: locked.slice(0, 3),
        });
      this.reports.set(input.batchId, list);
    }

    const remaining = rows.filter((r) => r.outcome === "pending").length;
    batch.committedCount = rows.filter((r) => r.outcome !== "pending").length;
    batch.state = remaining === 0 ? "committed" : "committing";
    this.bumpBatch(batch);

    return this.settleImport(input.idempotencyKey, {
      ok: true,
      batch: { ...batch },
      created,
      updated,
      skipped,
      failed,
      remaining,
    } as ImportCommitResult);
  }

  async importReport(batchId: string): Promise<ImportColumnReportView[]> {
    const rows = this.importRows.get(batchId) ?? [];
    const list = (this.reports.get(batchId) ?? []).filter(
      (r) => r.disposition === "unmapped" || r.disposition === "unknown-column" || r.disposition === "locked",
    );

    // Engine-owned columns the file disagreed with, on rows that matched.
    for (const [label, field] of [
      ["Company", "company"],
      ["Title", "title"],
      ["URL", "url"],
    ] as const) {
      const differing = rows.filter((r) => {
        if (!["updated", "skipped"].includes(r.outcome)) return false;
        const app = this.appById(r.matchedApplicationId ?? -1);
        if (!app) return false;
        const theirs = blankTrim(r.mapped[field]);
        if (!theirs) return false;
        const mine = field === "url" ? (app.url ?? "") : (app[field] as string);
        return companyNameKey(theirs) !== companyNameKey(mine);
      });
      if (differing.length > 0) {
        list.push({
          column: label,
          disposition: "read-only",
          rows: differing.length,
          sample: differing.slice(0, 3).map((r) => blankTrim(r.mapped[field])),
        });
      }
    }

    for (const [label, field] of [
      ["Status", "status"],
      ["Notes", "notes"],
      ["Next action", "nextAction"],
      ["Next action date", "nextActionDate"],
      ["Applied", "appliedDate"],
    ] as const) {
      // What LANDED, not what the file offered — `wroteColumns`, recorded by the
      // commit. See its docstring on `FixtureImportRow`.
      const n = rows.filter(
        (r) => ["created", "updated"].includes(r.outcome) && (r.wroteColumns ?? []).includes(field),
      ).length;
      if (n > 0) list.push({ column: label, disposition: "imported", rows: n, sample: [] });
    }

    // The columns the marker ERASED — the report saying so is half the
    // feature. From `clearedColumns`, recorded by the commit.
    for (const [label, field] of [
      ["Next action", "nextAction"],
      ["Next action date", "nextActionDate"],
      ["Applied", "appliedDate"],
    ] as const) {
      const n = rows.filter(
        (r) => r.outcome === "updated" && (r.clearedColumns ?? []).includes(field),
      ).length;
      if (n > 0) list.push({ column: label, disposition: "cleared", rows: n, sample: [] });
    }

    return list.sort(
      (a, b) => a.disposition.localeCompare(b.disposition) || a.column.localeCompare(b.column),
    );
  }

  async discardImport(input: DiscardImportInput): Promise<DiscardImportResult> {
    const replay = this.replayImport<DiscardImportResult>(input.idempotencyKey);
    if (replay) return replay;
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    // Anything that has WRITTEN is history. The way to reverse a commit is undo,
    // which leaves a trail; a delete would leave none, and would take
    // `import_rows` with it — the only record of what the file actually said.
    if (["committing", "committed", "rolled_back"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: "this import has already written rows — undo it instead of discarding it",
      };
    }
    this.batches.delete(input.batchId);
    this.importRows.delete(input.batchId);
    this.reports.delete(input.batchId);
    return this.settleImport(input.idempotencyKey, { ok: true } as DiscardImportResult);
  }

  async undoImport(input: UndoImportInput): Promise<ImportUndoResult> {
    const replay = this.replayImport<ImportUndoResult>(input.idempotencyKey);
    if (replay) return replay;
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      return { ok: false, kind: "error", message: "idempotency key required" };
    }
    const batch = this.batchOr(input.batchId);
    if (!batch) {
      return { ok: false, kind: "error", message: `no such import: ${input.batchId}` };
    }
    if (batch.state === "rolled_back") {
      return { ok: false, kind: "error", message: "this import has already been undone" };
    }
    if (!["committing", "committed"].includes(batch.state)) {
      return {
        ok: false,
        kind: "error",
        message: `this import has not written anything to undo (state ${batch.state})`,
      };
    }
    // Read from the batch, never from the client's clock — the button being on
    // screen is not authorisation.
    if (batch.undoExpiresAt && new Date(batch.undoExpiresAt).getTime() <= Date.now()) {
      return {
        ok: false,
        kind: "error",
        message: `the 24-hour undo window for this import closed at ${batch.undoExpiresAt}`,
      };
    }

    const rows = this.importRows.get(input.batchId) ?? [];
    let deleted = 0;
    let reverted = 0;
    let kept = 0;
    let notesKept = 0;
    const keptIds: number[] = [];

    for (const row of rows) {
      if (!["created", "updated"].includes(row.outcome)) continue;
      const app = this.appById(row.matchedApplicationId ?? -1);
      if (!app) continue;
      // The token this import left behind. A row whose version has moved was
      // acted on by somebody afterwards, and reverting it throws away work
      // nobody asked to lose.
      //
      // Compared as an INSTANT, matching the SQL's `::timestamptz` cast. Both
      // strings here come from this store's own clock so they always render the
      // same way, which is exactly what made the SQL's string comparison look
      // fine: the fake could not reproduce a session TimeZone, so the fake could
      // not have caught it. Written this way so the two say the same thing.
      if (!sameInstant(app.updatedAt, row.wroteUpdatedAt)) {
        kept += 1;
        keptIds.push(app.id);
        continue;
      }
      if (row.outcome === "created") {
        this.apps = this.apps.filter((a) => a.id !== app.id);
        this.notesByApp.delete(app.id);
        deleted += 1;
      } else {
        const before = row.revertBefore;
        if (before) {
          Object.assign(app, {
            status: before.status,
            statusActor: before.statusActor,
            nextAction: before.nextAction,
            nextActionDate: before.nextActionDate,
            appliedDate: before.appliedDate,
            updatedAt: this.bumpedApp(app),
          });
        }
        reverted += 1;
        // Imported notes on a surviving row STAY: the notes table is
        // append-only, and undoing an import is not a licence to delete history.
        notesKept += (this.notesByApp.get(app.id) ?? []).filter(
          (n) => n.author === "import",
        ).length;
      }
    }

    batch.state = "rolled_back";
    this.bumpBatch(batch);
    return this.settleImport(input.idempotencyKey, {
      ok: true,
      batch: { ...batch },
      deleted,
      reverted,
      kept,
      keptIds: keptIds.slice(0, 20),
      notesKept,
    } as ImportUndoResult);
  }
}
