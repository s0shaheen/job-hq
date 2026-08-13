import { safeHref } from "@/lib/url/safe-href";
import type { EmailMessage } from "@/lib/email/provider";
import type { LifecycleSendKind } from "@/lib/email/store";

/**
 * The three lifecycle templates (#203): activation, suspension, and the
 * deletion confirmation #204 will trigger. Plain sentences, no marketing.
 *
 * WHAT MAY APPEAR: the account-state fact and the user's own address/name.
 * Nothing else — no jobs, notes, resume content, or counts (the
 * private-content rule). The suspension REASON is deliberately absent too:
 * `entitlements.reason` is the operator's note, and 0027 says it is not shown
 * to the user.
 *
 * ABSENT FACTS ARE OMITTED, NEVER PLACEHOLDERED. A user with no recorded name
 * gets no greeting line; the string `Not listed` is a grid convention and must
 * never reach an email.
 *
 * EVERY USER-SUPPLIED STRING IS HTML-ESCAPED at the one place HTML is built. A
 * user named `<img src=x onerror=…>` renders as text. The plain-text part
 * carries the same content unescaped, because text/plain has no parser to
 * inject into.
 *
 * THE ONE LINK is the sign-in URL, and only when the caller provides one that
 * passes `safeHref` — the same algorithm the digest email and every render
 * surface use (absolute http(s), no userinfo, no encoded userinfo). No URL, or
 * an unsafe one, means the sentence is omitted; the handler is the layer that
 * refuses loudly on a misconfigured URL, so the template never guesses.
 */

const PRODUCT = "Job Search HQ";

export type LifecycleFacts = {
  email: string;
  /** "" means unknown: the greeting is omitted, never invented. */
  name: string;
  /** Optional sign-in link; rendered only if it passes safeHref. */
  appUrl?: string;
};

const BODY: Record<LifecycleSendKind, { subject: string; state: string; signIn: boolean }> = {
  "lifecycle.activation": {
    subject: `Your ${PRODUCT} account is active`,
    state: "Your account is active. You can sign in now.",
    signIn: true,
  },
  "lifecycle.suspension": {
    subject: `Your ${PRODUCT} account is suspended`,
    state:
      "Your account has been suspended. Sign-in is disabled until it is turned back on. " +
      "Your data stays where it is.",
    signIn: false,
  },
  "lifecycle.deletion_confirmation": {
    subject: `Your ${PRODUCT} account is deleted`,
    state:
      "Your account and its data have been deleted. " +
      `This address will receive no further email from ${PRODUCT}.`,
    signIn: false,
  },
};

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function lifecycleEmail(kind: LifecycleSendKind, facts: LifecycleFacts): EmailMessage {
  const body = BODY[kind];
  if (!body) {
    // Fail loud: a kind outside the vocabulary is a caller bug, and a template
    // that guesses would mail somebody a sentence about the wrong life event.
    throw new Error(`no lifecycle template for kind: ${kind}`);
  }
  const email = facts.email.trim();
  if (!email) {
    throw new Error("lifecycleEmail needs the recipient address");
  }
  const name = facts.name.trim();
  const link = body.signIn ? safeHref(facts.appUrl) : "";

  const textLines = [
    ...(name ? [`Hi ${name},`, ""] : []),
    body.state,
    ...(link ? ["", `Sign in: ${link}`] : []),
    "",
    `This email was sent to ${email} because the account's status changed.`,
  ];

  const htmlParts = [
    ...(name ? [`<p>Hi ${escapeHtml(name)},</p>`] : []),
    `<p>${escapeHtml(body.state)}</p>`,
    // `link` passed safeHref, so it carries no character that needs escaping
    // beyond what escapeHtml handles for the attribute position.
    ...(link ? [`<p><a href="${escapeHtml(link)}">Sign in</a></p>`] : []),
    `<p>This email was sent to ${escapeHtml(email)} because the account&#39;s status changed.</p>`,
  ];

  return {
    to: email,
    subject: body.subject,
    text: textLines.join("\n"),
    html: htmlParts.join("\n"),
  };
}
