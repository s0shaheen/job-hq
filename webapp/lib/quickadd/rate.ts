/**
 * The per-user bound on the resolve step's outbound reads.
 *
 * `resolveJobLinks` is user-driven outbound fetch: a signed-in person types,
 * our server reads pages on the open internet. The SSRF guard in `fetch.ts`
 * decides WHERE such a read may go; this gate decides HOW OFTEN one user may
 * ask for them at all, because an unbounded resolver is a free proxy and a
 * port-of-call scanner even when every target it will touch is public.
 *
 * THE BOUND, stated once so the number is a decision and not an accident:
 * 60 resolve calls per user per 10-minute fixed window. A resolve call reads
 * at most `MAX_LINKS` (25) pages, so the worst case one user can drive is
 * 1,500 outbound requests per window — noisy-neighbour scale, not
 * infrastructure scale. A human never sees it: the surface debounces to one
 * call per pause in typing, so 60 calls is a solid ten minutes of continuous
 * pasting.
 *
 * In-memory and per server instance, DELIBERATELY. A store-backed counter
 * would survive restarts and span instances, but it would put a database
 * write on every keystroke-settle of every user for an abuse margin measured
 * in single-digit multiples. This is an abuse damper, not billing-grade
 * accounting; the honest statement of what it bounds is "per user, per
 * instance, per window", and that is the statement the number above was
 * chosen against.
 *
 * The FIXTURE source carries no gate, and that asymmetry is the point rather
 * than a parity gap: its `readPage` is an in-memory lookup table, so there is
 * no outbound capability to bound — a demo user hammering resolve costs a map
 * lookup. The capability this gate protects exists only where the network
 * does.
 */

export const RESOLVE_LIMIT = 60;
export const RESOLVE_WINDOW_MS = 10 * 60 * 1000;

/** Refusals say what to do, not what subsystem said no. */
export const RESOLVE_RATE_MESSAGE =
  "Too many link checks in a short time. Wait a few minutes and try again.";

export class ResolveRateGate {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit = RESOLVE_LIMIT,
    private readonly windowMs = RESOLVE_WINDOW_MS,
  ) {}

  /** May this user resolve now? Counting is the asking — a refused call is
   *  counted against nothing, so refusal never extends the window. */
  allow(userId: string, now = Date.now()): boolean {
    // Opportunistic sweep so the map tracks users, not history. Bounded work:
    // it only runs when the map has grown past what one window of real use
    // explains.
    if (this.windows.size > 10_000) {
      for (const [key, w] of this.windows) {
        if (now - w.start >= this.windowMs) this.windows.delete(key);
      }
    }
    const current = this.windows.get(userId);
    if (!current || now - current.start >= this.windowMs) {
      this.windows.set(userId, { start: now, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}
