import "server-only";

import type { EmailEnv } from "@/lib/env";
import type { EmailMessage, EmailProvider, SendOutcome } from "@/lib/email/provider";

/**
 * The Resend implementation of the provider seam (#203).
 *
 * Plain `fetch` against the one endpoint rather than the vendor SDK: the API
 * surface this lane needs is a single POST, and a dependency is a supply-chain
 * surface this file would otherwise not have. The credential arrives through
 * the constructor — `getEmailEnv()` is read by the HANDLER, which passes it or
 * passes nothing, so "flag off means no client is ever constructed and no
 * network is ever attempted" is a property of the wiring, provable by a test,
 * rather than a branch inside this class.
 *
 * `import "server-only"` on top: a client component importing this is a build
 * failure. The key itself has no `NEXT_PUBLIC_` prefix, so it is never inlined
 * into a browser bundle — the same three-layer story as the service key, and
 * `tests/unit/service-key-containment.test.ts` pins all three layers.
 *
 * OUTCOME MAPPING, the part reviews should attack:
 *
 *   2xx with an id  → ok. Nothing else is.
 *   2xx WITHOUT id  → unknown: a different API than this was written against,
 *                     and the mail may exist. Reporting it sent would forge
 *                     provider evidence; reporting it failed would be a lie in
 *                     the other direction. Ambiguous stays ambiguous.
 *   4xx / 5xx       → failed, with the provider's own words in the reason —
 *                     the digest lane's AddressNotVerified doctrine: a
 *                     refusal is a refusal, never a success row.
 *   fetch throws    → unknown: the request may or may not have left. Never
 *                     blindly retried (the ledger keeps the claim).
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  private readonly env: EmailEnv;
  private readonly fetchImpl: FetchLike;

  constructor(env: EmailEnv, fetchImpl?: FetchLike) {
    this.env = env;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(message: EmailMessage): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.env.sender,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (err) {
      return {
        ok: false,
        outcome: "unknown",
        reason: `resend unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!response.ok) {
      // The provider answered and refused. Its body carries the why (Resend
      // answers `{name, message}`); a body this code cannot read still names
      // the status, never a success.
      let detail = "";
      try {
        const parsed = (await response.json()) as { name?: unknown; message?: unknown };
        detail = [parsed.name, parsed.message].filter((v) => typeof v === "string").join(": ");
      } catch {
        /* an unreadable refusal is still a refusal */
      }
      return {
        ok: false,
        outcome: "failed",
        reason: `resend ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    let id = "";
    try {
      const parsed = (await response.json()) as { id?: unknown };
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      /* falls through to the unknown answer below */
    }
    if (!id) {
      return {
        ok: false,
        outcome: "unknown",
        reason: `resend answered ${response.status} without a message id`,
      };
    }
    return { ok: true, providerMessageId: id };
  }
}
