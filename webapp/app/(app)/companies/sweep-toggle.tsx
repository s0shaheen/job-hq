"use client";

import type { CompanyView } from "@/lib/data/view-models";
import { ABSENT, sweepText } from "@/lib/grid/company-columns";
import { cn } from "@/lib/utils";

/**
 * The "Included in scans" cell, as the design's switch.
 *
 * It exists because `app_set_company_flags` and `setCompanyFlagsAction` had NO
 * caller. A live security-definer endpoint with nothing behind it is a door
 * nobody watches, and matrix row 86 was guarding a path the app could not reach —
 * which is the same "a test that cannot fail" smell one layer down.
 *
 * It toggles `monitor` only. `priority` rides through unchanged, because the
 * hourly watch list is a scheduling decision with its own cost and it has no UI
 * story on this surface yet — sending a value for it here would be inventing one.
 *
 * WHAT THE CUTOVER CHANGED, and only this: the control was a tone-coloured badge
 * reading "In scans" / "Watching" / "Paused", and `Coverage.dc.html` line 36
 * makes it a switch with the scope stated once in the column header. The write,
 * the optimistic patch, the version token and the revert are untouched.
 *
 * THE WORD DID NOT GO AWAY, it went to the accessible name. A bare `role=switch`
 * button with no accessible name is what the template ships, and a mock can
 * afford that because nobody drives it with a screen reader; a column of forty
 * of them announces "switch, on" forty times. `aria-label` carries the company
 * and the current state, so a sighted reader gets the design's clean control and
 * a screen-reader user gets "Ramp, in scans, switch, on". The two E2E assertions
 * that read the old badge's TEXT now read `aria-checked`, which is the same fact
 * stated where the platform can see it.
 *
 * Unapproved rows render the absence word, not a disabled control: the SQL
 * refuses the write (`review_state <> 'approved'` raises), and offering a switch
 * that always errors is worse than not offering it. Approving is the gesture
 * that turns the flag on, and the review bar is where that lives.
 */
export default function SweepToggle({
  company,
  busy,
  onToggle,
}: {
  company: CompanyView;
  busy: boolean;
  onToggle: (company: CompanyView, next: boolean) => void;
}) {
  const text = sweepText(company);
  if (text === ABSENT) {
    return (
      <span className="truncate text-muted" data-testid="sweep-none">
        {ABSENT}
      </span>
    );
  }
  const next = !company.enabled;
  const name = company.name.trim() || company.slug || "this company";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={company.enabled}
      aria-label={`${name}, ${text}`}
      disabled={busy}
      data-testid="sweep-toggle"
      data-enabled={company.enabled ? "true" : "false"}
      // The consequence, stated where the click is. The switch alone says "on";
      // this says what "on" currently buys.
      title={
        `${text}. Click to turn it ${next ? "on" : "off"}. ` +
        `Your choice is recorded here; discovery does not read it yet.`
      }
      onClick={() => onToggle(company, next)}
      // The BUTTON is the target and carries no paint: 32x24, which is WCAG 2.2
      // SC 2.5.8's 24x24 minimum. The visible 32x18 track lives in the span
      // below. That split exists because this control REPLACED a text badge —
      // the badge was comfortably tappable and an 18px-tall switch is not, once
      // per grid row, so shipping the track as the hit area would have been a
      // new touch regression rather than a re-skin.
      className={cn(
        "inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-md bg-transparent",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        busy ? "cursor-progress" : null,
      )}
    >
      <span
        aria-hidden
        // `rounded-md` — 6px, the radius `04-design-parity-standard.md` section
        // 3.3 gives every CONTROL. The design source draws this track as
        // `border-radius: 999px` and that is a real conflict, recorded as
        // DEV-COV-01 in `07-decisions-assumptions-risks.md` rather than settled
        // here.
        //
        // It was briefly `rounded-xl`. That was 12px chosen because the slop
        // detector tests `r > 12` — and 12px on an 18px-tall box paints a shape
        // the review measured as byte-identical to a 999px pill. A value picked
        // so the checker reads a declaration the eye never sees is worse than
        // the violation it hides, because it also spends the checker's
        // credibility. The rule's own words are "Radius above 12px; pill
        // buttons", and the pill half is the half that mattered.
        className={cn(
          "box-border flex h-[18px] w-8 items-center rounded-md border p-px",
          company.enabled
            ? "justify-end border-accent bg-accent"
            : "justify-start border-border-strong bg-border-strong",
        )}
      >
        {/* The knob stays a circle. A 14x14 square at full round is a dot, which
            the standard's badge/avatar carve-out and the detector's circular
            exemption both name; it is not the pill idiom. */}
        <span
          className={cn(
            "size-3.5 rounded-full",
            company.enabled ? "bg-accent-fg" : "bg-surface",
          )}
        />
      </span>
    </button>
  );
}
