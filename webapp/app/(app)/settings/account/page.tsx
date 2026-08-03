import { sessionEmail } from "../identity";
import { SectionHeading, SettingsShell } from "../settings-shell";

export const metadata = { title: "Account" };
export const dynamic = "force-dynamic";

/**
 * /settings/account — the fourth section of the rail.
 *
 * WHAT THE DESIGN DRAWS, AND WHAT SHIPS.
 *
 * `Settings.dc.html`'s Account section is four things: an Email row with a
 * "Change email" button, a Password row with a "Change password" button, a
 * Google connected-account card, and an "Email check" card describing a Gmail
 * watcher with a granted-scope grid and a Disconnect button.
 *
 * The Google card ships. The other three do not, and each has a recorded reason
 * rather than a silent omission:
 *
 *   * **The Gmail card is DEV-010.** DEC-002 excludes Gmail mailbox ingestion,
 *     and `CLAUDE.md` adds that nothing may imply Gmail is connected or
 *     monitoring. A disabled or "available soon" version of the card would still
 *     state that this product reads mail, so the card is absent entirely rather
 *     than present and inert.
 *   * **Change email and Change password are DEV-012.** There is no password
 *     identity in this product yet — Google is the only door — so "Change
 *     password" would be a control with nothing behind it, and "Change email"
 *     needs a confirmation mail whose sender identity is blocked on ADR-011.
 *
 * `tests/e2e/settings.spec.ts` asserts the Gmail absence over the whole rendered
 * section rather than over one selector, because the property is ABSENCE and a
 * narrower check passes a half-fix.
 */
export default async function SettingsAccountPage() {
  const email = await sessionEmail();

  return (
    <SettingsShell active="account">
      <SectionHeading title="Account" />

      <div className="mt-6 flex flex-col gap-1">
        <span className="text-sm font-medium text-text">Email</span>
        {/* `Not listed` and not a blank, an em dash or a guessed address. The
            demo mode this app's browser suite runs in has no session at all,
            and inventing one here would be the fixture-as-real-data failure the
            nav's missing "Alex Tran" fallback already refuses. */}
        <span data-testid="account-email" className="text-sm text-text-2">
          {email ?? "Not listed"}
        </span>
      </div>

      <div className="mt-6 border-t border-border pt-6">
        {/* 12/16 weight 500 muted sentence case, which is 04 §3.2's section
            label and the design's own spelling of this one. */}
        <h3 className="text-xs leading-4 font-medium text-muted">Connected accounts</h3>

        <div
          data-testid="connected-accounts"
          className="mt-3 flex flex-col gap-3"
        >
          <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
            {/* A monogram, not a favicon fetched from google.com. The template
                loads `google.com/s2/favicons`, which is a request to a third
                party made from a page that knows who the user is — ADR-009's
                open question about logo privacy, on the one surface where the
                logo is worth nothing. */}
            <span
              aria-hidden
              className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded border border-border bg-raised text-2xs font-medium text-text-2"
            >
              G
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text">Google</div>
              <div className="text-sm text-text-2">
                {email ? `Signed in as ${email}` : "Signed in"}
              </div>
              {/* The consent boundary, stated where the connection is, because
                  this is the only place a person can check it. Sign-in asks for
                  identity and nothing else; there is no mail scope to list, and
                  no scope grid, because none was ever requested. */}
              <div className="mt-2 text-xs text-muted">
                Used to sign you in. It does not read your mail.
              </div>
            </div>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}
