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
} from "./source";
import { IMPORT_LIST_LIMIT } from "./source";
import {
  FIXTURE_APPLICATIONS,
  FIXTURE_HEALTH,
  FIXTURE_JOBS,
  FIXTURE_NOW,
} from "./fixtures";
import { FIXTURE_COMPANIES } from "./company-fixtures";
import { isTerminalStatus } from "@/lib/status";
import {
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
import { blankTrim, companyNameKey, PROPOSE_SOURCE_TAGS } from "./view-models";
import type {
  ApplicationView,
  ChannelHealthView,
  CompanyView,
  JobView,
  NoteView,
  SavedView,
} from "./view-models";

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
  /** The values as they were, for the revert. */
  revertBefore?: {
    status: string;
    statusActor: "system" | "user";
    nextAction: string | null;
    nextActionDate: string | null;
    appliedDate: string | null;
  };
};

export class FixtureDataSource implements DataSource {
  private jobsByKey = new Map<string, JobView>();
  private apps: ApplicationView[];
  private seenIdempotencyKeys = new Map<string, WriteResult>();
  private failNext: string | null = null;

  private channels: ChannelHealthView[];

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
  ) {
    for (const j of seed) this.jobsByKey.set(j.key, { ...j });
    this.apps = apps.map((a) => ({ ...a }));
    this.channels = channels.map((c) => ({ ...c }));
    // Injectable for the same reason health is: the `empty` demo seed must be
    // able to produce a zero-row /companies, or its empty state ships unlooked-at
    // (matrix row 15's lesson, and the "every collection a fake owns comes from
    // its constructor" rule that followed it).
    for (const c of companies) this.companiesById.set(c.id, { ...c });

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

  /** Force the next write to fail, so the UI's failure path can be tested. */
  failNextWrite(message = "Network unavailable"): void {
    this.failNext = message;
  }

  async queue(opts: QueueOptions = {}): Promise<JobView[]> {
    const limit = opts.limit ?? DEFAULT_QUEUE_LIMIT;
    return [...this.jobsByKey.values()]
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
      .map((j) => ({ ...j }));
  }

  async jobs(): Promise<JobView[]> {
    return [...this.jobsByKey.values()].sort(byFreshness).map((j) => ({ ...j }));
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
        updatedAt: new Date(
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

  // ---- saved views ------------------------------------------------------

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
        if (t !== m) diff[column] = { mine: m, theirs: t };
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

      if (row.conflictState === "resolved") {
        if (row.choices.status === "mine") status = "";
        if (row.choices.notes === "mine") note = "";
        if (row.choices.next_action === "mine") next = "";
        if (row.choices.next_action_date === "mine") nextDate = null;
        if (row.choices.applied_date === "mine") applied = null;
      }

      if (row.matchKind === "duplicate-in-file") {
        row.outcome = "skipped";
        row.error = "skipped: an earlier row in this file is the same job";
        skipped += 1;
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
        Object.assign(app, {
          status: writeStatus ? status : app.status,
          statusActor: writeStatus && roundTrip ? ("user" as const) : app.statusActor,
          // A blank cell is "I did not fill this in", never "delete it".
          nextAction: next !== "" ? next : app.nextAction,
          nextActionDate: nextDate ?? app.nextActionDate,
          appliedDate: applied ?? app.appliedDate,
          updatedAt: this.bumpedApp(app),
        });
        if (note) this.appendNote(app.id, note, "import");
        row.outcome = "updated";
        row.wroteUpdatedAt = app.updatedAt;
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
