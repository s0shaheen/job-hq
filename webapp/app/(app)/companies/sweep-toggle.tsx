"use client";

import { Badge } from "@/components/ui/badge";
import type { CompanyView } from "@/lib/data/view-models";
import { DASH, sweepText, sweepTone } from "@/lib/grid/company-columns";
import { cn } from "@/lib/utils";

/**
 * The Sweep-flag cell, as a control rather than a label.
 *
 * It exists because `app_set_company_flags` and `setCompanyFlagsAction` had NO
 * caller. A live security-definer endpoint with nothing behind it is a door
 * nobody watches, and matrix row 86 was guarding a path the app could not reach —
 * which is the same "a test that cannot fail" smell one layer down. The boring
 * option was to give the endpoint its one honest caller; the alternative was
 * deleting a write path the surface obviously wants.
 *
 * It toggles `monitor` only. `priority` rides through unchanged, because the
 * hourly watch list is a scheduling decision with its own cost and it has no UI
 * story on this surface yet — sending a value for it here would be inventing one.
 *
 * Unapproved rows render the dash, not a disabled control: the SQL refuses the
 * write (`review_state <> 'approved'` raises), and offering a switch that always
 * errors is worse than not offering it. Approving is the gesture that turns the
 * flag on, and the review bar is where that lives.
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
  if (text === DASH) {
    return (
      <span className="truncate text-muted" data-testid="sweep-none">
        {DASH}
      </span>
    );
  }
  const next = !company.enabled;
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="sweep-toggle"
      data-enabled={company.enabled ? "true" : "false"}
      aria-pressed={company.enabled}
      // The consequence, stated where the click is. The badge alone says "on";
      // this says what "on" currently buys.
      title={
        `Sweep flag: ${text}. Click to turn it ${next ? "on" : "off"}. ` +
        `The flag is recorded here; the discovery sweep does not read it yet.`
      }
      onClick={() => onToggle(company, next)}
      className={cn(
        "min-w-0 max-w-full rounded-md text-left",
        "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
        busy ? "cursor-progress opacity-60" : "hover:opacity-80",
      )}
    >
      <Badge tone={sweepTone(text)} className="whitespace-nowrap">
        {text}
      </Badge>
    </button>
  );
}
