import type { SupabaseClient } from "@supabase/supabase-js";
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
import type {
  ApplicationView,
  ChannelHealthView,
  Disposition,
  JobView,
  SavedView,
  Triage,
} from "./view-models";

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

const POSTING_COLS =
  "key, company, title, location, url, posted, first_seen, last_seen, status, tags, geo, source";
const CHANNEL_RUN_COLS = "channel, ran_at, fetched, new_rows, filtered, tagged, errors";

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
 * comp_range -> [min_k, max_k] in thousands of dollars.
 *
 * A port of monitor/comp.py `parse_comp` — the engine's parser is the
 * authority on the feed's formats and this must track it. It exists because
 * nothing in the database carries a parsed band: tags hold only the
 * `comp_range` string, and hardcoding these to null left the two numeric comp
 * columns in every export permanently blank in production while demo showed
 * numbers. Same conservatism as the original: anything that does not parse
 * cleanly is (null, null), never a guess.
 *
 * One deliberate departure: a band in a non-dollar currency stays null. The
 * export column header says "$k", and £85k written under it as if it were
 * dollars is a lie — monitor/comp.py can afford to be looser because it only
 * judges a floor. The fixture's Wise row (£85,000–£110,000 → null) pins this.
 */
const MONEY = /\$?\s*(\d[\d,]*\.?\d*)\s*([kK])?/g;
const NON_ANNUAL = /\b(hour|hourly|\/hr|per hour|day|daily|week|weekly|month|monthly)\b/i;
const NON_DOLLAR = /[£€¥₹]|\b(GBP|EUR|CAD|AUD|CHF|JPY|INR|SGD)\b/;
const MIN_PLAUSIBLE_K = 10; // below this it isn't an annual salary in $k
const MAX_PLAUSIBLE_K = 2000; // above this it's a typo or equity, not base

function toK(raw: string, kSuffix: boolean): number | null {
  const v = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  if (kSuffix) return v; // "150k" -> 150
  if (v >= 1000) return v / 1000; // "150000" -> 150
  return v; // bare "150" already reads as $150k
}

function parseCompRange(text: string | null): [number | null, number | null] {
  const s = (text ?? "").trim();
  if (!s || NON_ANNUAL.test(s) || NON_DOLLAR.test(s)) return [null, null];

  const vals: number[] = [];
  for (const m of s.matchAll(MONEY)) {
    const v = toK(m[1], Boolean(m[2]));
    if (v !== null && v >= MIN_PLAUSIBLE_K && v <= MAX_PLAUSIBLE_K) vals.push(v);
  }
  if (!vals.length) return [null, null];

  const low = s.toLowerCase();
  if (vals.length === 1) {
    const v = vals[0];
    if (low.includes("up to") || /^(max|under|below)/.test(low)) return [null, v]; // ceiling only
    if (s.includes("+") || low.includes("at least") || low.includes("starting") || low.includes("from"))
      return [v, null]; // floor only
    return [v, v]; // a single stated figure
  }
  return [Math.min(...vals), Math.max(...vals)];
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
    status: str(p.status),
    disposition: (String(up.disposition ?? "needs-info") as Disposition),
    dispositionReason: String(up.disposition_reason ?? ""),
    triage: (String(up.triage ?? "") as Triage),
    snoozeUntil: str(up.snooze_until),
    updatedAt: str(up.updated_at),
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
        "id, posting_key, company, title, url, status, suggested_status, evidence, applied_date, next_action, next_action_date, notes, updated_at",
      )
      .eq("user_id", this.userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      postingKey: str(r.posting_key),
      company: String(r.company ?? ""),
      title: String(r.title ?? ""),
      url: str(r.url),
      status: String(r.status ?? "Inbox"),
      suggestedStatus: str(r.suggested_status),
      evidence: str(r.evidence),
      appliedDate: str(r.applied_date),
      nextAction: str(r.next_action),
      nextActionDate: str(r.next_action_date),
      notes: str(r.notes),
      updatedAt: str(r.updated_at),
    }));
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

  // ---- saved views ------------------------------------------------------

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
