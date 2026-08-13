/**
 * The provider seam for transactional email (#203).
 *
 * One interface, two implementations with identical semantics: `ResendProvider`
 * (`lib/email/resend.ts`, server-only, the real thing) and
 * `FixtureEmailProvider` (`lib/email/fixture.ts`, zero network) — CLAUDE.md's
 * rule that every production data-source capability has a fixture equivalent.
 *
 * The outcome vocabulary is the load-bearing part, and it is three-valued on
 * purpose. The digest lane's `AddressNotVerified` handling is the precedent for
 * `failed`; Autopilot's `outcome_unknown` is the precedent for `unknown`:
 *
 *   ok       — the provider ACCEPTED and said which message. Nothing else may
 *              be reported as success; a 2xx without a message id is not this.
 *   failed   — the provider ANSWERED and refused (4xx/5xx). Definitely not
 *              sent; the reason carries the provider's own words.
 *   unknown  — the call itself died with no answer (network failure, a
 *              response shape this code was not written against). The mail may
 *              or may not exist. The ledger keeps it ambiguous and nothing
 *              ever blindly retries it.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  /** The plain-text part. Always present; some clients render nothing else. */
  text: string;
  /** The HTML part, with every user-supplied string already escaped. */
  html: string;
};

export type SendOutcome =
  | { ok: true; providerMessageId: string }
  | { ok: false; outcome: "failed" | "unknown"; reason: string };

export interface EmailProvider {
  /** Lands in `email_sends.provider`: 'resend' | 'fixture'. */
  readonly name: string;
  send(message: EmailMessage): Promise<SendOutcome>;
}
