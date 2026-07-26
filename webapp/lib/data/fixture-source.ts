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
import {
  FIXTURE_APPLICATIONS,
  FIXTURE_HEALTH,
  FIXTURE_JOBS,
  FIXTURE_NOW,
} from "./fixtures";
import { FIXTURE_COMPANIES } from "./company-fixtures";
import { isTerminalStatus } from "@/lib/status";
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
}
