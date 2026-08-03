import { CircleAlert, CircleDot, Check, RefreshCw } from "lucide-react";
import type { ActivityState } from "@/lib/data/view-models";
import { cn } from "@/lib/utils";

/**
 * The State cell's chip (`Coverage.dc.html` lines 96, 101, 106).
 *
 * Colour never travels alone. Every chip carries an icon AND the full sentence
 * the mapper produced — "Last succeeded 2h ago", not a green dot meaning it — so
 * the state survives a colour-blind reader, a greyscale print and a grid skimmed
 * at speed. That is also why there is no "ok"/"stale" pair here: those were two
 * words doing the work of four states, and the fourth state ("Never run") had
 * nowhere to go.
 *
 * `Never run` takes the quiet neutral treatment rather than a warning one. A job
 * that has not run yet is not failing, and dressing it in warn colour would send
 * a person looking for a fault on a fresh account.
 *
 * `rounded-md`, NOT the template's `border-radius: 999px`. The pill idiom is a
 * hard rule in this repo — radius above 12px, and `slop.spec.ts` measures the
 * computed value on every scanned route, which is how the first version of this
 * file was caught rendering a 33,554,432px radius. The template's own chips are
 * pills; the repo rule wins, and the conflict is recorded as DEV-COV-01 in
 * `docs/pilot-launch/07-decisions-assumptions-risks.md` rather than argued here.
 */
const STYLE: Record<ActivityState, { chip: string; icon: typeof Check }> = {
  succeeded: { chip: "bg-ok-subtle text-ok", icon: Check },
  running: { chip: "bg-info-subtle text-info", icon: RefreshCw },
  failing: { chip: "bg-danger-subtle text-danger", icon: CircleAlert },
  never: { chip: "bg-raised text-muted", icon: CircleDot },
};

export default function ActivityStateChip({
  state,
  label,
}: {
  state: ActivityState;
  label: string;
}) {
  const { chip, icon: Icon } = STYLE[state];
  return (
    <span
      data-testid="activity-state"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs tabular-nums whitespace-nowrap",
        chip,
      )}
    >
      <Icon size={12} strokeWidth={2} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
