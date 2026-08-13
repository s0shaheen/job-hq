import type { EmailMessage, EmailProvider, SendOutcome } from "@/lib/email/provider";
import type {
  ClaimOutcome,
  EmailStore,
  LifecycleSendKind,
  PendingLifecycleSend,
  SendRecord,
} from "@/lib/email/store";

/**
 * The fixture twins (#203): the provider and the store, with the real things'
 * SEMANTICS and none of their network. Under fixtures/demo the same templates
 * render through the same dispatch loop and tests assert on the rendered
 * artifact — CLAUDE.md's fixture-equivalence rule, and `docs/WEBAPP-BUILD.md`'s
 * harder half: **a fake must reproduce the real thing's failure modes.** The
 * ones that matter here, each pinned by a unit test:
 *
 *   * a taken send_key answers `claimed: false` with the existing status —
 *     including a row stuck at 'claimed' (the crash window);
 *   * a suppressed address answers a TERMINAL `claimed: false, suppressed`
 *     and occupies the key, exactly like `hq_email_claim_send`;
 *   * recording on an unclaimed key THROWS (`hq_email_record_send` raises);
 *   * the provider can be told to refuse or to die, because a fixture that
 *     only succeeds proves nothing about the failed/unknown paths.
 */

export class FixtureEmailProvider implements EmailProvider {
  readonly name = "fixture";
  readonly sent: EmailMessage[] = [];
  /** When set, every send answers this instead of succeeding. */
  refuseWith: SendOutcome | null = null;
  private counter = 0;

  async send(message: EmailMessage): Promise<SendOutcome> {
    if (this.refuseWith) return this.refuseWith;
    this.sent.push(message);
    this.counter += 1;
    return { ok: true, providerMessageId: `fixture-${this.counter}` };
  }
}

type LedgerRow = {
  sendKey: string;
  userId: string;
  kind: LifecycleSendKind;
  recipient: string;
  status: string;
  provider: string;
  providerMessageId: string;
  reason: string;
};

export class FixtureEmailStore implements EmailStore {
  readonly ledger: LedgerRow[] = [];
  readonly suppressions = new Map<string, { reason: string; source: string }>();
  private pending: PendingLifecycleSend[] = [];

  seedPending(rows: PendingLifecycleSend[]): void {
    this.pending = [...rows];
  }

  suppress(address: string, reason: string, source: string): void {
    const key = address.toLowerCase();
    // The first reason stands, like the unique index's `do nothing`.
    if (!this.suppressions.has(key)) this.suppressions.set(key, { reason, source });
  }

  row(sendKey: string): LedgerRow | undefined {
    return this.ledger.find((r) => r.sendKey === sendKey);
  }

  async pendingLifecycle(): Promise<PendingLifecycleSend[]> {
    // The real read excludes any event whose key the ledger holds, whatever
    // its status — a claimed, sent, skipped, or suppressed row all silence it.
    return this.pending.filter((p) => !this.row(p.sendKey));
  }

  async claimSend(input: {
    sendKey: string;
    userId: string;
    kind: LifecycleSendKind;
    recipient: string;
  }): Promise<ClaimOutcome> {
    const existing = this.row(input.sendKey);
    if (existing) {
      return { claimed: false, status: existing.status, reason: existing.reason };
    }
    const recipient = input.recipient.trim().toLowerCase();
    const suppression = this.suppressions.get(recipient);
    if (suppression) {
      const reason = `suppressed: ${suppression.reason} (${suppression.source || "unrecorded source"})`;
      this.ledger.push({
        sendKey: input.sendKey,
        userId: input.userId,
        kind: input.kind,
        recipient,
        status: "suppressed",
        provider: "",
        providerMessageId: "",
        reason,
      });
      return { claimed: false, status: "suppressed", reason };
    }
    this.ledger.push({
      sendKey: input.sendKey,
      userId: input.userId,
      kind: input.kind,
      recipient,
      status: "claimed",
      provider: "",
      providerMessageId: "",
      reason: "",
    });
    return { claimed: true };
  }

  async recordSend(sendKey: string, record: SendRecord): Promise<void> {
    const row = this.row(sendKey);
    if (!row || row.status !== "claimed") {
      throw new Error(
        `no claimed row for key ${sendKey} — either nothing claimed it or its outcome is already recorded`,
      );
    }
    row.status = record.status;
    row.provider = record.provider;
    row.providerMessageId = record.status === "sent" ? record.providerMessageId : "";
    row.reason = record.status === "sent" ? "" : record.reason;
  }
}
