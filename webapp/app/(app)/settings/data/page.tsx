import Link from "next/link";
import { buttonClass } from "@/components/ds";
import { sessionEmail } from "../identity";
import { SectionHeading, SettingsShell } from "../settings-shell";

export const metadata = { title: "Data" };
export const dynamic = "force-dynamic";

/**
 * /settings/data — the third section of the rail.
 *
 * `Settings.dc.html` draws four blocks: Import, Export defaults, Export
 * everything, and Delete account behind a typed-email confirmation.
 *
 * IMPORT is real and wired: the wizard shipped end to end (migration 0011,
 * strong and weak keys, resumable batches), and this is the door 06 §A asks for.
 *
 * EXPORT DEFAULTS is not here (DEV-013). The design's two knobs, format and
 * "include ID columns", are per-dialog state in `components/export-dialog.tsx`
 * with no column behind them; making them defaults is a `profiles` migration,
 * which is a serial change and not this packet's to make.
 *
 * EXPORT EVERYTHING and DELETE ACCOUNT ship as SURFACES and are INERT, stated on
 * screen and not only here. Both are T4 in `14-work-packet-standard.md` §4:
 * deletion has to stop sessions, workers, queued commands, notifications and
 * provider tokens before it deletes anything, and it needs a deletion ledger so
 * a restored backup cannot reactivate the account (RM-72). The archive has to
 * span every object class in that same requirement. Neither exists.
 *
 * The controls are therefore DISABLED with the reason beside them, rather than
 * enabled with a handler that refuses. A control that looks live and then says
 * no has already taken the decision away from the person: they have pressed the
 * button that deletes their account. This one cannot be pressed, and says why.
 */
export default async function SettingsDataPage() {
  const email = await sessionEmail();

  return (
    <SettingsShell active="data">
      <SectionHeading title="Data" />

      <div className="mt-6 flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">Import</span>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-text-2">
              Bring roles and applications in from a CSV file.
            </span>
            {/* An anchor wearing the button's class, never a Button inside a
                Link: an `<a>` around a `<button>` is invalid markup and screen
                readers announce the pair as two controls. */}
            <Link href="/import" data-testid="data-import" className={buttonClass()}>
              Import CSV
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-6 border-t border-border pt-6">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text">Export everything</span>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-text-2">
                One archive with every role, application, answer, and setting.
              </span>
              <button
                type="button"
                data-testid="data-export-everything"
                disabled
                aria-describedby="data-export-everything-why"
                className={buttonClass({ disabled: true })}
              >
                Export everything
              </button>
            </div>
            <p id="data-export-everything-why" className="text-xs text-muted">
              Not available yet. Roles and applications can be exported one set at
              a time from Jobs.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text">Delete account</span>
            <span className="text-sm text-text-2">
              Deletion removes everything and can't be undone. Export everything first
              if you want a copy.
            </span>
            {/* The irreversibility ADD-007 names, said before the control rather
                than in a confirmation nobody reads: an application already sent
                to an employer is not recalled by deleting the account here. */}
            <span className="text-sm text-text-2">
              Applications already submitted to an employer stay with that employer.
              Deleting this account does not withdraw them.
            </span>

            <label htmlFor="data-delete-confirm" className="mt-2 text-xs text-muted">
              Type your account email to confirm
            </label>
            <input
              id="data-delete-confirm"
              data-testid="data-delete-confirm"
              type="email"
              disabled
              aria-describedby="data-delete-why"
              placeholder={email ?? undefined}
              className="h-8 w-70 max-w-full rounded-md border border-border bg-raised px-2 text-sm text-muted"
            />
            <div className="mt-1">
              <button
                type="button"
                data-testid="data-delete-account"
                disabled
                aria-describedby="data-delete-why"
                className={buttonClass({ disabled: true })}
              >
                Delete account
              </button>
            </div>
            {/* No "ask support". 02 §7's template is "[what happened]. [what to
                do, or what happens next]", and the second half has to name a
                door that exists — this product surfaces no support address
                anywhere, and ADR-011 has not decided the support identity yet.
                Pointing at a channel nobody can find is worse than saying
                nothing: it reads as an answer and dead-ends the one person who
                acts on it. So the sentence states what happens next instead. */}
            <p id="data-delete-why" className="text-xs text-muted">
              Not available yet. Deletion has to stop every running job and provider
              connection before it removes anything, and that is not built. Nothing
              is deleted until it is.
            </p>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}
