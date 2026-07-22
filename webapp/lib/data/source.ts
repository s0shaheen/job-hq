/**
 * The data boundary. One interface, two implementations.
 *
 * Everything the UI needs comes through `DataSource`, so the app can run
 * against Postgres in production and against deterministic fixtures in tests
 * and demo mode. Two things fall out of that, and both are load-bearing:
 *
 *   1. End-to-end tests need no database. Playwright drives the real UI over
 *      known data, which is what makes visual-regression snapshots stable and
 *      lets CI run without a Supabase project.
 *   2. The app can be looked at before anything is provisioned. Demo mode is
 *      a working preview rather than a mockup.
 *
 * The Python side has the same shape (`core/fakes.py`), and it has already
 * paid for itself — including the time the fake was MORE FORGIVING than the
 * real API (it grew a spreadsheet grid that Google refuses to grow), so the
 * whole suite passed while production could not write a column. A fake earns
 * its keep by reproducing failure modes, not just happy paths.
 */
import type {
  ApplicationView,
  ChannelHealthView,
  JobView,
  SavedView,
  Triage,
} from "./view-models";

export type QueueOptions = {
  /** Hard cap. A queue that cannot be finished is just another inbox. */
  limit?: number;
};

export type TriageInput = {
  postingKey: string;
  triage: Triage;
  snoozeUntil?: string | null;
  reason?: string;
  /** Client-generated; makes a double-tap or a retry free. */
  idempotencyKey: string;
  /** The value the client last read. A mismatch is a conflict, not a clobber. */
  expectedUpdatedAt: string | null;
};

/**
 * `auth` is separated from `error` deliberately, because the two demand
 * opposite responses. A rejected write is final — revert the row and say so. A
 * write refused because the session expired is not a rejection at all: the
 * decision was valid, it simply could not be delivered yet. Collapsing them
 * means an expired session silently throws away the last thing the user did,
 * which is the version of this bug people actually notice.
 */
export type WriteResult =
  | { ok: true; job: JobView }
  | { ok: false; kind: "conflict"; current: JobView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * Saving a view. `id` is null to create, or an existing id to update in place;
 * `expectedUpdatedAt` is the version the client last read, so a second device
 * editing the same view conflicts rather than clobbers. `state` is opaque to
 * the store — filters, sort, group, column layout and density all ride inside
 * it, and the database never looks in.
 */
export type SaveViewInput = {
  id: string | null;
  name: string;
  surface: string;
  state: unknown;
  isDefault: boolean;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type SaveViewResult =
  | { ok: true; view: SavedView }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type DeleteViewInput = {
  id: string;
  idempotencyKey: string;
};

export type DeleteViewResult =
  | { ok: true }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export interface DataSource {
  /** Qualified, untriaged, freshest first. */
  queue(opts?: QueueOptions): Promise<JobView[]>;
  /** Everything, for the grid — filtering happens client-side over this. */
  jobs(): Promise<JobView[]>;
  applications(): Promise<ApplicationView[]>;
  health(): Promise<ChannelHealthView[]>;
  setTriage(input: TriageInput): Promise<WriteResult>;

  /** A user's saved grid states for a surface. Built-in presets live in code. */
  savedViews(surface: string): Promise<SavedView[]>;
  saveView(input: SaveViewInput): Promise<SaveViewResult>;
  deleteView(input: DeleteViewInput): Promise<DeleteViewResult>;
}

/**
 * Demo mode is opt-in and never the default: a production deployment that
 * silently served fixtures would be indistinguishable from a working app
 * while showing invented jobs, which is worse than an error page.
 */
export function isDemoMode(): boolean {
  return process.env.HQ_DEMO === "1" || process.env.NEXT_PUBLIC_HQ_DEMO === "1";
}
