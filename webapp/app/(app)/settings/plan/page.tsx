import { getSessionEntitlement } from "@/lib/data/get-source";
import { SectionHeading, SettingsShell } from "../settings-shell";

export const metadata = { title: "Plan & billing" };
export const dynamic = "force-dynamic";

/**
 * /settings/plan — the fifth section of the rail.
 *
 * `Settings.dc.html` draws exactly two lines here: the label "Plan" and the
 * value "Free". `PlanBilling.dc.html` draws the rest of the commercial seam —
 * usage sentences, a change-plan dialog, the Free/Pro comparison — and that is
 * ADD-006, which has no approved design for anything past the founding-free
 * view. So this section is the two lines the owner authored and nothing else.
 *
 * The value is READ, not hardcoded: `entitlements.plan` is the column migration
 * 0027 created as the billing seam, and `invited` is the owner's free-forever
 * flag (DEC-005). Printing a literal "Free" would be a claim about somebody's
 * account made without looking at it, which is the same defect as a fixture
 * rendered as real data.
 *
 * NOTHING HERE CHARGES OR CHANGES A PLAN. There is no Stripe integration, no
 * checkout, and no upgrade control, because RM-70 is unbuilt and ADR-015 is
 * unsigned. A section that showed a price with a button beside it would be the
 * charging surface, half-built.
 */
export default async function SettingsPlanPage() {
  const read = await getSessionEntitlement().catch(() => null);
  const entitlement = read?.kind === "ok" ? read.entitlement : null;

  return (
    <SettingsShell active="plan">
      <SectionHeading title="Plan & billing" />

      <div className="mt-6 flex flex-col gap-1">
        <span className="text-sm font-medium text-text">Plan</span>
        <span data-testid="plan-name" className="text-sm text-text-2">
          {/* `Not listed` when the entitlement could not be read, rather than
              defaulting to "Free": this is the one line on the page and a
              guessed value here is a statement about what somebody is paying. */}
          {entitlement ? planLabel(entitlement.plan) : "Not listed"}
        </span>
        {entitlement?.invited ? (
          <span data-testid="plan-founding" className="mt-1 text-xs text-muted">
            Free forever, with no usage limits on the product itself.
          </span>
        ) : null}
      </div>
    </SettingsShell>
  );
}

/**
 * The stored plan key as the word a person reads.
 *
 * `'free'` is the only value 0027 issues today. An unrecognised key renders
 * itself rather than being collapsed into "Free": a plan this build has never
 * heard of is not evidence that somebody is on the free one.
 */
function planLabel(plan: string): string {
  return plan === "free" ? "Free" : plan;
}
