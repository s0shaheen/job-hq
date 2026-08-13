/**
 * The store seam for transactional email (#203) — the ledger side of the send
 * path, mirroring `lib/capture/store.ts` / `lib/digest/store.ts`: a small
 * interface for a sessionless boundary, so the fake the unit suite drives is a
 * fake of three operations, and the real thing
 * (`lib/supabase/service.ts:SupabaseEmailStore`) is three RPC calls.
 *
 * THE STORE, NOT THE CALLER, IS THE DEDUPE. `claimSend` maps to
 * `hq_email_claim_send`, which inserts the ledger row BEFORE any provider is
 * contacted and answers `claimed: false` for a key it has seen — including a
 * key stuck at `claimed` because a previous dispatcher died after the provider
 * accepted. Suppression is consulted INSIDE the same claim, so a send path
 * that forgets to check cannot exist.
 */

/** `email_sends.kind` — the closed vocabulary the migration owns. */
export type LifecycleSendKind =
  | "lifecycle.activation"
  | "lifecycle.suspension"
  | "lifecycle.deletion_confirmation";

/**
 * One row from `hq_email_pending_lifecycle()`: an entitlement lifecycle event
 * with no ledger row yet, carrying the recipient facts the templates need and
 * NOTHING else — no jobs, notes, resume content, or counts.
 */
export type PendingLifecycleSend = {
  /** `evt:<events.id>` — the idempotency key the ledger enforces unique. */
  sendKey: string;
  userId: string;
  /** `events.kind`: entitlement.activated | entitlement.suspended. */
  eventKind: string;
  email: string;
  /** May be "" — users.name defaults to it. Omitted from mail, never placeholdered. */
  name: string;
  occurredAt: string;
};

export type ClaimOutcome =
  | { claimed: true }
  /**
   * `status` is the existing/terminal row's status: 'suppressed' when the
   * address is on the suppression list (reason names which suppression),
   * anything else when the key was already handled — or is stuck at 'claimed'
   * from a dispatcher that died mid-send, which must stay unclaimed forever.
   */
  | { claimed: false; status: string; reason: string };

export type SendRecord =
  | { status: "sent"; provider: string; providerMessageId: string }
  | { status: "skipped" | "failed" | "unknown"; provider: string; reason: string };

export interface EmailStore {
  pendingLifecycle(): Promise<PendingLifecycleSend[]>;
  claimSend(input: {
    sendKey: string;
    userId: string;
    kind: LifecycleSendKind;
    recipient: string;
  }): Promise<ClaimOutcome>;
  /** Lands one outcome on one claimed row; THROWS for an unclaimed key. */
  recordSend(sendKey: string, record: SendRecord): Promise<void>;
}
