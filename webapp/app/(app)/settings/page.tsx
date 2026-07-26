import { Settings } from "lucide-react";
import { DisplayPrefs } from "./display-prefs";

export const metadata = { title: "Search profile — Job Search HQ" };

/**
 * Placeholder with real anchor targets. The editable profile — wizard,
 * preview-before-commit — is the profile phase (docs/plans/PHASE-PROFILE.md)
 * and is deliberately NOT built here.
 *
 * What must exist NOW are the anchors: the filtered-empty queue's one primary
 * action links to `/settings#<setting>`, and before this page existed the
 * app's own escape hatch dead-ended on a bare 404. The ids below are the
 * exact outputs of `reasonSetting()` in lib/data/view-models.ts — fixed
 * there, per conflict C11 in docs/plans/README.md ("do not invent a second
 * id set"), and routing.spec.ts derives them from that function so a new
 * reason kind fails the suite until its anchor lands here.
 */
const SETTINGS: { id: string; label: string; body: string }[] = [
  {
    id: "countries",
    label: "Countries",
    body: "Which countries a posting may be located in. Roles anywhere else are filtered out of the queue.",
  },
  {
    id: "metros",
    label: "Metros",
    body: "The US metros you follow. Postings placed in another metro — or in none — are filtered.",
  },
  {
    id: "yoeMax",
    label: "Years-of-experience limit",
    body: "The most years of experience a posting may ask for and still reach your queue.",
  },
  {
    id: "seniorityExclude",
    label: "Seniority exclusions",
    body: "Seniority levels above your range. Postings at an excluded level are filtered.",
  },
  {
    id: "compMin",
    label: "Compensation floor",
    body: "The minimum stated pay. Postings that state a range below it are filtered.",
  },
  {
    id: "workModelExclude",
    label: "Work-model exclusions",
    body: "Work models you have ruled out — for example onsite-only roles.",
  },
];

export default function SettingsPage() {
  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Search profile</h1>
        <p className="text-xs text-muted">
          The settings that decide what reaches your queue and what gets filtered.
        </p>
      </header>

      <div className="mx-auto max-w-2xl space-y-3 px-4 py-5 sm:px-6">
        <p className="flex items-start gap-2 text-sm text-muted">
          <Settings aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Editing these here isn’t built yet — it arrives later in the build
            order, with a preview of what each change would let through. For
            now, the values live in the Config tab of the HQ sheet, and that is
            where a change takes effect.
          </span>
        </p>

        {/* The one thing on this page that IS editable here. It sets a cookie and
            needs no store, which is why it does not wait for PHASE-PROFILE. */}
        <DisplayPrefs />

        {SETTINGS.map((s) => (
          <section
            key={s.id}
            id={s.id}
            aria-labelledby={`${s.id}-heading`}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <h2 id={`${s.id}-heading`} className="text-sm font-semibold">
              {s.label}
            </h2>
            <p className="mt-1 text-sm text-muted">{s.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
