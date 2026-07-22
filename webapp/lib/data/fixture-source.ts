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
  DataSource,
  DeleteViewInput,
  DeleteViewResult,
  QueueOptions,
  SaveViewInput,
  SaveViewResult,
  TriageInput,
  WriteResult,
} from "./source";
import {
  FIXTURE_APPLICATIONS,
  FIXTURE_HEALTH,
  FIXTURE_JOBS,
  FIXTURE_NOW,
} from "./fixtures";
import type {
  ApplicationView,
  ChannelHealthView,
  JobView,
  SavedView,
} from "./view-models";

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
  ) {
    for (const j of seed) this.jobsByKey.set(j.key, { ...j });
    this.apps = apps.map((a) => ({ ...a }));
    this.channels = channels.map((c) => ({ ...c }));
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
    return this.apps.map((a) => ({ ...a }));
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
        suggestedStatus: null,
        evidence: null,
        appliedDate: null,
        nextAction: null,
        nextActionDate: null,
        notes: null,
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
