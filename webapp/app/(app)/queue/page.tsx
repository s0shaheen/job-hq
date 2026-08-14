import { ExportDialog } from "@/components/export-dialog";
import { PageHeader } from "@/components/ds";
import { getDataSource } from "@/lib/data/get-source";
import { isDemoMode } from "@/lib/data/source";
import { FIXTURE_NOW } from "@/lib/data/fixtures";
import { bindingConstraint } from "@/lib/data/view-models";
import { toLocalIsoDate } from "@/lib/dates";
import TodayList from "./today-list";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

/**
 * Today — the owner's composition (`templates/today-triage/TodayTriage.dc.html`).
 *
 * A single column, `max-w-[760px]`, centred in the content area. Not the 640px
 * form width: this is a list, and the composition states the number.
 *
 * NO bounded frame. The document scrolls here, which is the app's default and
 * what every surface had before #121 gave the shell `h-dvh overflow-hidden` for
 * Jobs' virtualizer and took document scrolling away from twelve surfaces that
 * never asked for it. Today renders its rows directly — there is no
 * virtualizer, so there is nothing here that needs a bounded scroll parent, and
 * `tests/e2e/layout.spec.ts` holds /queue to the default frame.
 *
 * The header keeps its Export control. The composition has no page action on
 * Today, and dropping the dialog would be deleting a working capability under
 * cover of a visual change; `PageHeader`'s `action` slot is where a page's one
 * primary control goes, so it goes there.
 *
 * The overnight digest line ("Submitted 2 applications overnight. View log") is
 * absent, and absent is its correct rendering: it is drawn only when auto-submit
 * has fired, Autopilot's submission log is blocked on E2, and this app has no
 * read that can answer whether anything was submitted overnight. A line that
 * always said "Submitted 2" would be a fixture presented as the user's history.
 */
/**
 * The calendar day the fact line's "2d ago" is measured against.
 *
 * In demo mode that is FIXTURE_NOW, not the wall clock, because the fixture set
 * is dated relative to FIXTURE_NOW and the browser tests pin their clock to it.
 * `lib/data/fixtures.ts` states the rule in its first paragraph: "2d ago" is
 * "2d ago" forever, which is what keeps the visual baselines stable.
 *
 * Reading the real clock here broke that on the one surface that renders an
 * age. With the fixtures dated around 21 Jul and the server two weeks past it,
 * every row fell through to the ABSOLUTE branch — Today showed "Jul 19" where
 * the composition shows a relative age, and no browser test ever rendered the
 * relative branch at all.
 */
function todayFor(): string {
  return toLocalIsoDate(isDemoMode() ? new Date(FIXTURE_NOW) : new Date());
}

export default async function QueuePage() {
  const today = todayFor();
  const src = await getDataSource();
  // The profile read exists for ONE number: the user's own YoE ceiling, which
  // the mismatch hint compares against. It used to be a hardcoded 4 — the
  // deployment owner's ceiling annotating every user's queue (RM-40 vault
  // audit §9 Step 4). An unset ceiling (null) shows no mismatch hints.
  const [rows, profile] = await Promise.all([
    src.queue({ limit: 20 }),
    src.profile(),
  ]);

  // Read only when there is nothing to show. An empty queue has two causes
  // that look the same and mean opposite things — nothing found versus the
  // profile gating everything out — and only the second is worth a second
  // query. On the ordinary path this costs nothing.
  const constraint = rows.length > 0 ? null : bindingConstraint(await src.jobs());

  return (
    <div className="min-w-0 p-4 md:p-6">
      <div className="mx-auto max-w-[760px]">
        {/* No subtitle. `PageHeader`'s subtitle carries operating information
            and the count it would carry is already on the section header one
            line below, where the composition puts it. Two copies of one number
            is two places for it to disagree. */}
        <PageHeader title="Today" action={<ExportDialog dataset="jobs" />} />
        <TodayList
          initial={rows}
          yoeMax={profile.criteria?.yoe_max ?? null}
          constraint={constraint}
          today={today}
        />
      </div>
    </div>
  );
}
