import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataSource, QueueOptions, TriageInput, WriteResult } from "./source";
import type {
  ApplicationView,
  ChannelHealthView,
  Disposition,
  JobView,
  Triage,
} from "./view-models";

const POSTING_COLS =
  "key, company, title, location, url, posted, first_seen, last_seen, status, tags, geo, source";

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

export function toJobView(up: Record<string, unknown>): JobView | null {
  const p = (Array.isArray(up.postings) ? up.postings[0] : up.postings) as
    | Record<string, unknown>
    | undefined;
  if (!p) return null;
  const tags = (p.tags ?? {}) as Record<string, unknown>;
  const geo = (p.geo ?? {}) as Record<string, unknown>;
  const skills = str(tags.skills);

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
    compMinK: null, // parsed server-side by the engine; not needed to render
    compMaxK: null,
    minYoe: num(tags.min_yoe),
    seniority: str(tags.seniority),
    industry: str(tags.company_industry),
    roleFocus: str(tags.role_focus),
    skills: skills ? skills.split(";").map((s) => s.trim()).filter(Boolean) : [],
    posted: str(p.posted),
    firstSeen: str(p.first_seen),
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
        .order("postings(last_seen)", { ascending: false, nullsFirst: false })
        .limit(opts.limit ?? 20),
    );
  }

  jobs(): Promise<JobView[]> {
    return this.userPostings((q) =>
      q.order("postings(last_seen)", { ascending: false, nullsFirst: false }).limit(5000),
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
      .select("channel, ran_at, fetched, new_rows, filtered, tagged, errors")
      .order("ran_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const latest = new Map<string, ChannelHealthView>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const channel = String(r.channel ?? "");
      if (latest.has(channel)) continue; // ordered desc: first is newest
      const ranAt = str(r.ran_at);
      latest.set(channel, {
        channel,
        ranAt,
        fetched: Number(r.fetched ?? 0),
        newRows: Number(r.new_rows ?? 0),
        filtered: Number(r.filtered ?? 0),
        tagged: Number(r.tagged ?? 0),
        errors: Number(r.errors ?? 0),
        ageHours: ranAt ? (Date.now() - new Date(ranAt).getTime()) / 3_600_000 : null,
        cadenceHours: CADENCE[channel] ?? 24,
      });
    }
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
}

/** Mirrors tracker/digest.py CADENCE_HOURS — keep in step. */
const CADENCE: Record<string, number> = {
  monitor: 12, review: 24, tracker: 2, cafe: 24, theirstack: 24,
  simplify: 24, selfheal: 24, snapshot: 24, capture: 1.5,
};
