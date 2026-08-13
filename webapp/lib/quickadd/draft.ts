/**
 * The one rule about a draft's idempotency key, extracted so it is testable:
 * WHEN a retry is the same gesture and when it stops being one.
 *
 * The key is minted once per row and reused on every retry — that reuse is
 * what makes the write idempotent, and `app_add_job` holds the caller to it
 * with `hq_command_replay`'s request fingerprint: the same key arriving with
 * DIFFERENT arguments raises 22023 instead of silently answering the first
 * gesture's result. Which is exactly what a retry after an edit is. The
 * first attempt failed on screen, but a failure the client saw is not proof
 * the server never committed — a lost response is the case idempotency
 * exists for — so a retry carrying corrected fields under the old key would
 * either be refused (22023, an honest but useless toast) or, worse under the
 * pre-0026 contract, report the UN-edited write as if the correction landed.
 *
 * So: an edit to a row that has already been attempted mints a fresh key.
 * The edited row is a new gesture by definition — the user changed what they
 * are asking for. If the failed attempt did commit server-side, the fresh
 * key's write finds the posting already tracked and answers `duplicate`,
 * which is true. An edit BEFORE any attempt keeps the key: nothing has been
 * sent, so there is no first gesture to diverge from.
 */

export type EditableDraft = {
  /** The idempotency key the next attempt will carry. */
  idem: string;
  outcome: "pending" | "added" | "duplicate" | "failed";
  /** The two fields the surface lets the user correct. */
  company_: string;
  title_: string;
};

export function applyDraftEdit<T extends EditableDraft>(draft: T, patch: Partial<T>): T {
  const next = { ...draft, ...patch };
  const changed = next.company_ !== draft.company_ || next.title_ !== draft.title_;
  return draft.outcome === "failed" && changed ? { ...next, idem: crypto.randomUUID() } : next;
}
