import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/empty";
import { getDataSource } from "@/lib/data/get-source";
import { isDemoMode } from "@/lib/data/source";
import { FIXTURE_NOW } from "@/lib/data/fixtures";
import { companyNameKey } from "@/lib/data/view-models";
import { getBoardSource } from "@/lib/apply/board-source";
import { httpUrlOrEmpty, resolveApplyTarget, type ApplyTarget } from "@/lib/apply/board";
import { parseGreenhouseForm } from "@/lib/apply/greenhouse";
import { prepareApplication } from "@/lib/apply/prepare";
import { engineAnswers, engineRules } from "@/lib/apply/views";
import { ReviewSurface } from "./review";

export const metadata = { title: "Prepare" };
export const dynamic = "force-dynamic";

/**
 * /apply/[applicationId] — Prepare, then Review. Step 2 of
 * `docs/plans/AUTO-APPLY.md`'s build shape, and it stops there.
 *
 * The whole pipeline this page performs:
 *
 *   resolve   which board and which job this row points at (pure, `board.ts`)
 *   fetch     the keyless `?questions=true` schema (bounded, `board-source.ts`)
 *   parse     the payload into an ATS-independent form (`greenhouse.ts`)
 *   prepare   the form + this user's answers and rules → a staged application
 *             (`prepare.ts`, pure, no clock, no network, no model)
 *
 * There is no submit, and nothing reachable from here can submit. `AUTO-APPLY.md`
 * puts the value plainly: "here is every question this job will ask,
 * pre-answered" turns a 20-minute application into a 3-minute review-and-paste
 * even when a person does the typing.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE FOUR REFUSALS ARE FOUR DIFFERENT SCREENS
 *
 * "Prepare did not work" is four different facts, and a person can act on three
 * of them: another ATS family (nothing to do, yet), a URL that names no board
 * (paste the board link), a posting that is gone (stop working on it), a board
 * that did not answer (try later). One shared error page would flatten all of
 * that into a shrug.
 */
export default async function ApplyPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const { applicationId } = await params;
  // DIGITS, anchored, before `Number` sees it. `Number("0x1")` is 1 and
  // `Number(" 1 ")` is 1, so `/apply/0x1` rendered application 1 — harmless
  // (the lookup is RLS-scoped) and the guard read stricter than it was, which is
  // the half that stops being harmless when somebody trusts it later.
  if (!/^[0-9]+$/.test(applicationId)) notFound();
  const id = Number(applicationId);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  const src = await getDataSource();
  const applications = await src.applications();
  const application = applications.find((a) => a.id === id);
  // RLS scopes the read, so "not yours" and "does not exist" are one answer
  // here — which is the right way round for a page keyed by a guessable integer.
  if (!application) notFound();

  const target = resolveApplyTarget({
    postingKey: application.postingKey,
    url: application.url,
  });

  // Every href on this page goes through the scheme guard. `application.url` is
  // whatever the sweep, an import or a paste put on the row, and `form.url` is
  // third-party JSON — the same class `lib/referral/linkedin.ts` guards, for the
  // same reason (`connectionUrl`'s comment names it).
  const postingUrl = httpUrlOrEmpty(application.url);

  const head = (
    <header className="border-b border-border px-4 py-3 sm:px-6">
      <p className="text-xs text-muted">
        <Link href="/pipeline" className="underline">
          Pipeline
        </Link>
      </p>
      <h1 className="text-lg font-semibold">{application.title}</h1>
      <p className="text-xs text-muted">
        {application.company}. Every question this form will ask, answered from what you
        have already told this app. Nothing is submitted from here.
      </p>
    </header>
  );

  if (target.kind !== "greenhouse") {
    return (
      <div className="min-w-0" data-testid="apply-page" data-state={target.kind}>
        {head}
        <div className="mx-auto max-w-3xl px-4 pt-8 sm:px-6">
          <NotPreparable target={target} url={postingUrl} />
        </div>
      </div>
    );
  }

  const fetched = await getBoardSource().form(target);
  if (!fetched.ok) {
    return (
      <div className="min-w-0" data-testid="apply-page" data-state={`fetch-${fetched.reason}`}>
        {head}
        <div className="mx-auto max-w-3xl px-4 pt-8 sm:px-6">
          <EmptyState
            title={
              fetched.reason === "not-found"
                ? "This posting is not on the board any more"
                : "The board did not answer"
            }
            body={
              <>
                {fetched.message} Nothing was staged, and nothing was guessed from the little
                that came back.{" "}
                {postingUrl ? (
                  <Link
                    href={postingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Open the posting
                  </Link>
                ) : null}
              </>
            }
          />
        </div>
      </div>
    );
  }

  let form;
  try {
    form = parseGreenhouseForm(fetched.payload);
  } catch (err) {
    // The parser throws on a payload that is not a job — a 404 body, an error
    // envelope, a job fetched without `?questions=true`. Caught rather than
    // thrown at the error boundary, because "the board answered with something
    // we could not read" is a state this page can describe and a white screen is
    // not (matrix row 3, from the other side).
    return (
      <div className="min-w-0" data-testid="apply-page" data-state="parse-failed">
        {head}
        <div className="mx-auto max-w-3xl px-4 pt-8 sm:px-6">
          <EmptyState
            title="The board answered with something this app could not read"
            body={
              <>
                {err instanceof Error ? err.message : "What came back was not a job posting."}{" "}
                Nothing was staged. A form this parser cannot describe unambiguously is not one
                to prepare against.
              </>
            }
          />
        </div>
      </div>
    );
  }

  const [answers, rules, jobs] = await Promise.all([
    src.answers(),
    src.policyRules(),
    // The posting's own country, for the questions that defer to it ("the
    // country where this position is located" — what Coinbase asks). Omitting it
    // GAPS those questions on purpose: `prepare.ts` has no "assume the US"
    // branch, and inventing one here would be the same wrong answer one layer up.
    //
    // It costs a full postings read for one row, which is what `/jobs` already
    // does on every visit and is bounded the same way. A targeted read is worth
    // adding the day this page is opened in a loop.
    src.jobs(),
  ]);
  const posting = application.postingKey
    ? jobs.find((j) => j.key === application.postingKey)
    : undefined;

  const staged = prepareApplication({
    form,
    answers: engineAnswers(answers),
    rules: engineRules(rules),
    // Company identity comes from `lib/data/view-models`, computed once, because
    // one module owns it — `lib/apply/index.ts` takes the key pre-computed for
    // exactly this reason.
    companyKey: companyNameKey(application.company),
    postingCountry: posting?.country ?? undefined,
    // The clock, pinned in demo mode and only there.
    //
    // `start_date`'s computed directive resolves against today, so a demo left on
    // the wall clock renders a different date every morning — and `page.clock`
    // freezes the BROWSER, not the server that computes this. Every fixture date
    // in this app already hangs off `FIXTURE_NOW` for exactly that reason, and a
    // visual baseline or an assertion that rots overnight is worse than none.
    today: isDemoMode() ? new Date(FIXTURE_NOW) : undefined,
  });

  return (
    <div className="min-w-0" data-testid="apply-page" data-state="prepared">
      {head}
      <ReviewSurface
        staged={staged}
        company={application.company}
        title={application.title}
        boardUrl={httpUrlOrEmpty(form.url) || postingUrl}
      />
    </div>
  );
}

/**
 * The three "there is nothing to fetch" states, each saying what it does not
 * support rather than failing at it.
 */
function NotPreparable({ target, url }: { target: ApplyTarget; url: string | null }) {
  if (target.kind === "unsupported-ats") {
    return (
      <EmptyState
        title={`Prepare does not read ${target.ats} yet`}
        body={
          <>
            Greenhouse is the only job board whose questions can be read without opening a
            browser, which is why it is the one this works on. It is 43% of the companies this
            system tracks. Ashby, Lever and SmartRecruiters have hosted forms that have to be
            parsed page by page, and that is not built. Nothing about this posting was guessed
            at.{" "}
            {url ? (
              <Link href={url} target="_blank" rel="noopener noreferrer" className="underline">
                Open the posting
              </Link>
            ) : null}
          </>
        }
      />
    );
  }
  if (target.kind === "no-board") {
    return (
      <EmptyState
        title="This link does not say which board it belongs to"
        body={
          <>
            The question list is keyed by the company's board token and the job id, and
            this URL carries only one of them
            {target.jobId ? ` (job ${target.jobId})` : ""}. That is what an embedded form, or a
            company careers page carrying <code>?gh_jid=</code>, looks like. Open the posting,
            copy its <code>{"boards.greenhouse.io/<company>/jobs/<id>"}</code> link, and paste
            that onto the row.
          </>
        }
      />
    );
  }
  // `unknown` means "no posting key, and no URL this app can read a BOARD out
  // of". It does not mean the row has no link: a perfectly good Lever or Workday
  // URL lands here, and the old copy asserted "no board link" for all of them —
  // a fact it had not checked, on the one refusal screen that offered no way out.
  return (
    <EmptyState
      title="Nothing here says where this application lives"
      body={
        url ? (
          <>
            This row has no posting key, and its link is not one Prepare can read a board out
            of. Nothing about it was guessed at.{" "}
            <Link href={url} target="_blank" rel="noopener noreferrer" className="underline">
              Open the posting
            </Link>
          </>
        ) : (
          "This row has no posting key and no link at all. It was typed in or imported from a spreadsheet, so there is no form to read."
        )
      }
    />
  );
}
