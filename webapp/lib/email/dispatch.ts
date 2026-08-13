import type { EmailProvider } from "@/lib/email/provider";
import type { EmailStore, LifecycleSendKind } from "@/lib/email/store";
import { lifecycleEmail } from "@/lib/email/templates";

/**
 * The dispatch loop (#203): consume the entitlement lifecycle facts the
 * operator RPCs already recorded, and turn each into exactly one ledger row.
 *
 * ORDER OF OPERATIONS IS THE WHOLE DESIGN — claim FIRST, provider second,
 * outcome last:
 *
 *   1. `claimSend` writes the ledger row. A refused claim (taken key,
 *      suppressed address) ends the item here: no template renders, no
 *      provider is consulted.
 *   2. With `provider: null` (the flag is off), the claim is recorded
 *      `skipped` with the NAMED reason and logged — a loud skip, terminal on
 *      purpose: "your account is on" arriving weeks later, when the flag
 *      flips, would be mail about nothing. The fact was recorded; the mail
 *      era starts with the flag.
 *   3. Otherwise render, send, and record what the provider actually said:
 *      sent with its message id, failed with its refusal, unknown when the
 *      call died unanswered. A provider that THROWS is recorded `unknown` too
 *      — the mail may exist, and the claim keeps every re-run away from it.
 *
 * A store failure (claim or record throwing) propagates: the dispatcher runs
 * on its own request with nothing riding on it, and a dead ledger must page,
 * not accumulate silent debt. The one send it may strand stays `claimed`,
 * which is the safe direction — never re-sent, visible in the ledger.
 */

/** `events.kind` → `email_sends.kind`. A third event kind is schema drift and raises. */
const EVENT_TO_SEND: Record<string, LifecycleSendKind> = {
  "entitlement.activated": "lifecycle.activation",
  "entitlement.suspended": "lifecycle.suspension",
};

export type DispatchSummary = {
  considered: number;
  sent: number;
  skipped: number;
  suppressed: number;
  failed: number;
  unknown: number;
  alreadyHandled: number;
};

export type DispatchOptions = {
  store: EmailStore;
  /** null = the flag is off; disabledReason then names which input is missing. */
  provider: EmailProvider | null;
  disabledReason?: string;
  /** Sign-in link for the activation template; already safeHref-validated by the handler. */
  appUrl?: string;
  /** The loud channel for skips. Defaults to console.warn — a log line, not silence. */
  log?: (line: string) => void;
};

export async function dispatchLifecycleEmail(opts: DispatchOptions): Promise<DispatchSummary> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  if (opts.provider === null && !opts.disabledReason) {
    throw new Error(
      "dispatchLifecycleEmail: a null provider needs a disabledReason — a skip without a name is a silent drop",
    );
  }

  const summary: DispatchSummary = {
    considered: 0,
    sent: 0,
    skipped: 0,
    suppressed: 0,
    failed: 0,
    unknown: 0,
    alreadyHandled: 0,
  };

  const due = await opts.store.pendingLifecycle();
  for (const item of due) {
    summary.considered += 1;

    const kind = EVENT_TO_SEND[item.eventKind];
    if (!kind) {
      throw new Error(
        `dispatchLifecycleEmail: no send kind for event ${item.eventKind} — the read and this map disagree`,
      );
    }

    const claim = await opts.store.claimSend({
      sendKey: item.sendKey,
      userId: item.userId,
      kind,
      recipient: item.email,
    });
    if (!claim.claimed) {
      if (claim.status === "suppressed") {
        summary.suppressed += 1;
        log(`email dispatch: ${item.sendKey} refused, ${claim.reason}`);
      } else {
        summary.alreadyHandled += 1;
      }
      continue;
    }

    if (opts.provider === null) {
      const reason = opts.disabledReason ?? "";
      await opts.store.recordSend(item.sendKey, { status: "skipped", provider: "", reason });
      summary.skipped += 1;
      log(`email dispatch: ${item.sendKey} (${kind}) SKIPPED, ${reason}`);
      continue;
    }

    const message = lifecycleEmail(kind, {
      email: item.email,
      name: item.name,
      appUrl: opts.appUrl,
    });

    let outcome;
    try {
      outcome = await opts.provider.send(message);
    } catch (err) {
      outcome = {
        ok: false as const,
        outcome: "unknown" as const,
        reason: `provider threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (outcome.ok) {
      await opts.store.recordSend(item.sendKey, {
        status: "sent",
        provider: opts.provider.name,
        providerMessageId: outcome.providerMessageId,
      });
      summary.sent += 1;
    } else {
      await opts.store.recordSend(item.sendKey, {
        status: outcome.outcome,
        provider: opts.provider.name,
        reason: outcome.reason,
      });
      summary[outcome.outcome] += 1;
      log(`email dispatch: ${item.sendKey} (${kind}) ${outcome.outcome.toUpperCase()}, ${outcome.reason}`);
    }
  }

  return summary;
}
