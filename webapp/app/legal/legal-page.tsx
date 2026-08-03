import { AuthColumn, AuthTitle } from "@/components/auth-column";

/**
 * `/terms` and `/privacy`, before they have content.
 *
 * The auth column's legal line points here (DEV-011). The documents themselves
 * are owner and counsel input, blocked on ADR-012 — privacy and terms, the
 * processor list, the AI no-training posture and consent versioning are one
 * decision, and no worker writes a privacy policy from taste.
 *
 * So the page states the absence rather than filling it. 02 §7's error template
 * is `[What happened]. [What to do, or what happens next.]`, and it applies to a
 * missing document as much as to a failed write: a person who clicked "Privacy"
 * asked a real question and deserves a real answer about where the answer is,
 * not a 404 and not a page of placeholder legalese, which would be worse than
 * nothing because it would look like terms somebody agreed to.
 *
 * They render in the auth column because that is where the links live and
 * because a signed-out visitor must be able to read them; there is no session
 * and therefore no shell.
 */
export function LegalPage({ title }: { title: "Terms" | "Privacy" }) {
  return (
    <AuthColumn testId={`legal-${title.toLowerCase()}`}>
      <AuthTitle>{title}</AuthTitle>
      <p className="mt-2 text-sm text-text-2">
        This document is not published yet.
      </p>
      <p className="mt-2 text-sm text-text-2">
        Job HQ is invite-only and has not opened to the public. The terms and
        privacy documents are published before it does.
      </p>
    </AuthColumn>
  );
}
