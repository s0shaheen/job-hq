/**
 * AN IN-MEMORY STAND-IN FOR THE ONE SHARED SUPABASE PROJECT.
 *
 * The live lane's whole namespace design is a claim about what happens when two
 * runs touch one project at the same time. That claim cannot be asserted
 * honestly — "they will not collide" is the sort of sentence that stays true in
 * a comment long after the code stopped agreeing with it — and it cannot be
 * demonstrated against the real project either, because the real project is the
 * scarce shared resource the design exists to arbitrate. Booking it to prove a
 * property about booking it is the wrong shape.
 *
 * So: the REAL `LiveAdmin` — the real seeder, the real teardown, the real reaper,
 * no reimplementation — driven against this. It answers `admin.ts`'s `AdminClient`
 * interface and models only what makes the properties falsifiable:
 *
 *   - the UNIQUE constraint on `auth.users.email`, so a genuine collision between
 *     two namespaces would surface as the error a real project would raise
 *     rather than as a silently overwritten row;
 *   - `created_at` from an injectable clock, so orphan reclamation is provable
 *     without waiting two hours;
 *   - an `await` on every operation, so two seeds started together really do
 *     interleave rather than running to completion one after the other.
 *
 * It is NOT a Postgres. It has no RLS, and it is not pretending to: RLS is what
 * the live lane itself proves, in a browser, against the real project. What this
 * proves is the layer underneath, which the live lane cannot test from inside —
 * that two runs' data sets are disjoint at all.
 */
import type { AdminClient, AdminResult, AdminTable } from "../live/admin";

export interface FakeUser {
  id: string;
  email: string;
  created_at: string;
}

interface Row {
  [column: string]: unknown;
}

/** Yield to the event loop, so concurrent callers actually interleave. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class FakeProject {
  readonly users: FakeUser[] = [];
  /** table -> rows. `postings`, `profiles`, `user_postings`, `entitlements`. */
  readonly tables = new Map<string, Row[]>();
  /** Every rpc call, so the seeder's use of the operator path stays visible. */
  readonly rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  /** Milliseconds. Advance it to age rows. */
  now: number;
  private nextId = 1;

  constructor(startedAt = Date.parse("2026-08-03T12:00:00.000Z")) {
    this.now = startedAt;
    for (const t of ["postings", "profiles", "user_postings", "entitlements"]) {
      this.tables.set(t, []);
    }
  }

  advance(ms: number): void {
    this.now += ms;
  }

  rows(table: string): Row[] {
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`fake project has no table ${table}`);
    return rows;
  }

  /** A client wired to this project. Each `LiveAdmin` gets its own. */
  client(): AdminClient {
    const project = this;
    return {
      auth: {
        admin: {
          async listUsers({ page, perPage }) {
            await tick();
            const start = (page - 1) * perPage;
            return { data: { users: project.users.slice(start, start + perPage) } };
          },
          async createUser({ email }) {
            await tick();
            const normalised = email.trim().toLowerCase();
            // The constraint that makes a collision LOUD. Without it two
            // namespaces sharing an address would quietly become one row and
            // the test would prove nothing.
            if (project.users.some((u) => u.email === normalised)) {
              return { error: { message: `duplicate key value: ${normalised} already exists` } };
            }
            const user: FakeUser = {
              id: `user-${project.nextId++}`,
              email: normalised,
              created_at: new Date(project.now).toISOString(),
            };
            project.users.push(user);
            // What `handle_new_auth_user` does. Seeding asserts on it, and a
            // fake without it would fail on migration 0027 instead of on the
            // property under test.
            project.rows("entitlements").push({ user_id: user.id, status: "pending" });
            return { data: { user: { id: user.id } } };
          },
          async deleteUser(id) {
            await tick();
            const at = project.users.findIndex((u) => u.id === id);
            if (at < 0) return { error: { message: `no such user ${id}` } };
            project.users.splice(at, 1);
            for (const table of ["entitlements", "profiles", "user_postings"]) {
              const rows = project.rows(table);
              for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (rows[i]!.user_id === id) rows.splice(i, 1);
              }
            }
            return {};
          },
        },
      },
      from(table: string): AdminTable {
        return makeTable(project, table);
      },
      async rpc(name, args) {
        await tick();
        project.rpcCalls.push({ name, args });
        const userId = args.p_user_id;
        const row = project.rows("entitlements").find((r) => r.user_id === userId);
        if (!row) return { error: { message: `no entitlement row for ${String(userId)}` } };
        if (name === "hq_activate_user") row.status = "active";
        else if (name === "hq_suspend_user") row.status = "suspended";
        else return { error: { message: `unknown rpc ${name}` } };
        return {};
      },
    };
  }
}

/** The tiny slice of PostgREST's builder the seeder uses. */
function makeTable(project: FakeProject, table: string): AdminTable {
  const filters: { column: string; value: unknown }[] = [];
  let mode: "select" | "delete" = "select";
  let columns: string[] = [];

  const matches = (row: Row) => filters.every((f) => row[f.column] === f.value);

  const builder: AdminTable = {
    select(cols: string) {
      mode = "select";
      columns = cols.split(",").map((c) => c.trim());
      return builder;
    },
    eq(column, value) {
      filters.push({ column, value });
      return builder;
    },
    delete() {
      mode = "delete";
      return builder;
    },
    async in(column, values) {
      await tick();
      const wanted = new Set(values);
      const rows = project.rows(table);
      if (mode === "delete") {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (wanted.has(rows[i]![column]) && matches(rows[i]!)) {
            // `user_postings` cascades from `postings`, which teardown relies
            // on: it deletes postings only and expects ownership to follow.
            if (table === "postings") {
              const owns = project.rows("user_postings");
              for (let j = owns.length - 1; j >= 0; j -= 1) {
                if (owns[j]!.posting_key === rows[i]!.key) owns.splice(j, 1);
              }
            }
            rows.splice(i, 1);
          }
        }
        return {};
      }
      return { data: rows.filter((r) => wanted.has(r[column]) && matches(r)) };
    },
    async like(column, pattern) {
      await tick();
      // Only the trailing-`%` form the reaper uses. Anything else is a bug in
      // the caller, and answering it plausibly would hide that.
      if (!pattern.endsWith("%") || pattern.slice(0, -1).includes("%")) {
        return { error: { message: `fake project only models 'prefix%' patterns, got ${pattern}` } };
      }
      const prefix = pattern.slice(0, -1);
      const rows = project
        .rows(table)
        .filter((r) => typeof r[column] === "string" && (r[column] as string).startsWith(prefix));
      return {
        data: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))),
      };
    },
    async maybeSingle<T = Record<string, unknown>>() {
      await tick();
      const found = project.rows(table).filter(matches);
      if (found.length > 1) return { error: { message: `maybeSingle matched ${found.length}` } };
      return { data: (found[0] ?? null) as T | null };
    },
    async upsert(rows, options) {
      await tick();
      const keys = options.onConflict.split(",").map((k) => k.trim());
      const existing = project.rows(table);
      for (const incoming of rows as Row[]) {
        const at = existing.findIndex((r) => keys.every((k) => r[k] === incoming[k]));
        const stamped = { created_at: new Date(project.now).toISOString(), ...incoming };
        if (at >= 0) existing[at] = { ...existing[at], ...incoming };
        else existing.push(stamped);
      }
      return {};
    },
    // `delete().eq(...)` has no terminal call in this codebase's usage — it is
    // awaited directly, exactly as PostgREST's own thenable builder allows — so
    // the builder itself resolves for that one shape.
    then<T1 = AdminResult, T2 = never>(
      onfulfilled?: ((value: AdminResult) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      const settled = tick().then((): AdminResult => {
        if (mode === "delete") {
          const rows = project.rows(table);
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (matches(rows[i]!)) rows.splice(i, 1);
          }
        }
        return {};
      });
      return settled.then(onfulfilled, onrejected);
    },
  };
  return builder;
}

/**
 * A `LiveEnv` for the test project shape, with no real credentials in it.
 *
 * The ref is `job-hq-fake`, which is not the production ref, so `LiveAdmin`'s
 * constructor-time production refusal runs for real and passes for the right
 * reason rather than being bypassed.
 */
export const FAKE_ENV = {
  url: "https://jobhqfake.supabase.co",
  ref: "jobhqfake",
  anonKey: "anon-not-a-jwt",
  serviceKey: "service-not-a-jwt",
  password: "not-a-real-password",
} as const;
