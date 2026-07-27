"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { METRO_NAMES } from "@/lib/profile/metros";
import { describesASearch, MAX_YOE, type ProfileCriteria } from "@/lib/profile/criteria";
import {
  boardTermFromRole,
  titlesAreDerived,
  titlesFromRole,
  withDerivedDefaults,
} from "@/lib/profile/derive";
import { dollarsFromK, kFromDollars } from "@/lib/profile/money";
import { draftFromPreset, ROLE_PRESETS } from "@/lib/profile/presets";
import { encodeDraft, DRAFT_PARAM, FIRST_STEP, LAST_STEP } from "@/lib/profile/draft";
import { ChipList, MoneyField, NumberField, PolicyChoice } from "../../(app)/settings/fields";
import { PreviewPanel, type PreviewState } from "../../(app)/settings/preview-panel";
import { commitProfileAction, previewProfileAction } from "../../(app)/settings/actions";

/**
 * Setup, in two screens.
 *
 * It was six, one per setting, with three of them asking about unknown-handling
 * policies. The owner ran it as the first real user and the verdict was that it
 * needed to be far simpler, that step one should not be a choice between
 * product management and finance, and that the language was unreadable. All
 * three are the same defect: the wizard was organised around the ENGINE's
 * fields instead of around the two questions a person can answer without being
 * taught the product.
 *
 * So: what are you looking for, then where and how much. The engine's other
 * fields still exist and still ship with the same defaults; they sit behind a
 * disclosure on screen two, pre-filled, and almost nobody will open it.
 *
 *   * `board_search_term` and `titles_include` are DERIVED from the role rather
 *     than demanded (see `lib/profile/derive.ts`), so one typed field produces a
 *     profile the sweep can run. Both stay visible and editable.
 *   * The two curated title lists are TEMPLATES at the bottom of screen one, not
 *     the frame around it. A nurse should not have to declare herself "something
 *     else" before the app will talk to her.
 *   * The preview renders INLINE under the last question. It was a step of its
 *     own, which made the numbers feel like a checkpoint rather than an answer.
 */

const WRITE_TIMEOUT_MS = 15_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const STEP_TITLES: Record<number, string> = {
  1: "What are you looking for?",
  2: "Where, and how much?",
};

/** Templates, without the deliberately-empty third preset behind the radios. */
const TEMPLATES = ROLE_PRESETS.filter((p) => p.criteria.role_family !== "");

export default function Wizard({
  step,
  draft,
  rawDraft,
  version,
}: {
  step: number;
  draft: ProfileCriteria;
  rawDraft: string;
  version: string | null;
}) {
  const router = useRouter();
  const [criteria, setCriteria] = React.useState<ProfileCriteria>(draft);
  const [preview, setPreview] = React.useState<PreviewState>({ kind: "idle" });
  const [busy, setBusy] = React.useState<null | "check" | "save">(null);
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const idemRef = React.useRef<string>(crypto.randomUUID());

  /**
   * Visible is not interactive.
   *
   * The server renders this whole form — every input, every button — long before
   * React attaches a single handler, and on a loaded CI runner that gap is wide
   * enough to swallow a gesture entirely: a click into an unhydrated form fires
   * into nothing and the trace shows zero POSTs. `pipeline-table.tsx` earned this
   * the hard way (its two blur-commits both vanished), and matrix row 21 is the
   * same lesson from the keyboard side.
   *
   * A flag set in an effect CANNOT be true before the handlers exist, which is
   * exactly the property a test needs. Tests gate every entry to this surface on
   * it rather than on `toBeVisible`.
   */
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  const encoded = React.useMemo(() => encodeDraft(criteria), [criteria]);
  /** The draft no longer fits in a URL, so nothing may navigate until it does. */
  const [tooLong, setTooLong] = React.useState(false);

  // Two effects, and they are the whole "the draft lives in the URL" claim.
  //
  // ADOPT: keyed on the RAW parameter, so it fires when the URL's draft really
  // changed — a Back, a Forward, a refresh, a pasted link — and not on every
  // render. React keeps the state of a component it does not unmount, so
  // without this, Back to step 1 shows the answers as they are NOW.
  React.useEffect(() => {
    setCriteria(draft);
    // `draft` is derived from `rawDraft` and depending on it would re-run this
    // on every render, undoing the edit it just adopted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawDraft]);

  // SYNC: keep the CURRENT history entry carrying the CURRENT answers.
  //
  // Without this the draft is only written when Next is pressed, so a value
  // typed ON a step is absent from that step's own entry — type it, press Next,
  // press Back, and it is gone. Found by the Back test, which is what it is for.
  //
  // `history.replaceState`, not `router.replace`, and the difference is why the
  // first attempt still failed. `router.replace` is asynchronous and wanted a
  // debounce; the debounce's cleanup runs when `step` changes, so pressing Next
  // within 250ms of typing CANCELLED the write to the entry being left behind —
  // exactly the keystroke-then-navigate sequence a person performs. Next
  // intercepts `replaceState` and merges it into the router's own state with no
  // server round trip, so this is synchronous, free, and cannot be cancelled by
  // the navigation it is racing.
  //
  // Still `replace` rather than `push`, for the grid's reason (matrix row 59):
  // a history entry per keystroke makes Back walk backwards through typing
  // instead of through steps.
  React.useEffect(() => {
    if (encoded === null) {
      // Over the cap: leave the URL holding the last draft that DID fit, rather
      // than overwriting it with an empty `?d=` that the server then reads as
      // "no draft" and answers with the baseline. That sequence is what made the
      // silent drop unrecoverable — Back could not reach the answers either,
      // because the entry they were in had already been rewritten.
      setTooLong(true);
      return;
    }
    setTooLong(false);
    if (!encoded || encoded === rawDraft) return;
    window.history.replaceState(null, "", `/onboarding/${step}?${DRAFT_PARAM}=${encoded}`);
  }, [encoded, rawDraft, step]);

  // Focus the new step's heading. Matrix row 94: without this a screen-reader
  // user hears nothing at all when the step changes — the URL moved, the DOM
  // swapped, and focus stayed on a Next button that no longer exists.
  React.useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  function go(next: number, c: ProfileCriteria = criteria) {
    // Encoded from the CURRENT answers rather than from `encoded`, so a Next
    // pressed inside the sync effect still carries what was just typed.
    const q = encodeDraft(c);
    if (q === null) {
      // The draft will not fit in a URL, so this navigation would LOSE it — the
      // whole "answers live in the address bar" mechanism has a ceiling and it
      // has to be visible when it is reached. Refusing to navigate keeps the
      // answers on screen where they can be shortened; navigating and dropping
      // them silently is what this used to do.
      setTooLong(true);
      return;
    }
    setTooLong(false);
    router.push(`/onboarding/${next}?${DRAFT_PARAM}=${q}`);
  }

  function patch(next: Partial<ProfileCriteria>) {
    setCriteria((c) => ({ ...c, ...next }));
    // Any edit invalidates the numbers, on this surface as on /settings.
    setPreview((p) => (p.kind === "ready" ? { kind: "stale", preview: p.preview } : p));
  }

  /**
   * The role, plus the two engine fields that follow it while nobody has said
   * otherwise.
   *
   * `titlesAreDerived` is asked against the OLD role, so a list somebody typed
   * survives a later edit to the role box and a list this function wrote does
   * not. The result is a title chip that appears as you type and can be deleted
   * — which is the difference between a default and a guess.
   */
  function setRole(role: string) {
    setCriteria((c) => {
      const next: ProfileCriteria = { ...c, role_family: role };
      if (titlesAreDerived(c.titles_include, c.role_family)) {
        next.titles_include = titlesFromRole(role);
      }
      if (!c.board_search_term.trim() || c.board_search_term === boardTermFromRole(c.role_family)) {
        next.board_search_term = boardTermFromRole(role);
      }
      if (!c.tag_domain.trim() || c.tag_domain === c.role_family.trim()) {
        next.tag_domain = role.trim();
      }
      return next;
    });
    setPreview((p) => (p.kind === "ready" ? { kind: "stale", preview: p.preview } : p));
  }

  async function check(c: ProfileCriteria = criteria) {
    setBusy("check");
    setPreview({ kind: "running" });
    // Previewed through the same filling-in the save does, so the numbers on
    // screen belong to the profile that would be stored.
    const res = await withTimeout(previewProfileAction(withDerivedDefaults(c)), WRITE_TIMEOUT_MS);
    setBusy(null);
    if ("timedOut" in res) {
      setPreview({ kind: "failed", message: "it took too long" });
      return;
    }
    if (!res.ok) {
      setPreview({
        kind: "failed",
        message: res.kind === "auth" ? "your session expired" : res.message,
      });
      return;
    }
    setPreview({ kind: "ready", preview: res.preview });
  }

  // The last step runs the check on arrival: the panel is the answer to the
  // questions above it, and making somebody press a button to see it reads as a
  // page that has not finished loading.
  React.useEffect(() => {
    if (step !== LAST_STEP) return;
    if (preview.kind !== "idle") return;
    void check();
    // `criteria` is deliberately not a dependency: an edit marks the preview
    // stale and the user re-runs it, which is row 95's behaviour. Re-running on
    // every keystroke would be an unbounded fan-out for a number nobody asked to
    // recompute yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, preview.kind]);

  async function save() {
    setBusy("save");
    const res = await withTimeout(
      commitProfileAction(withDerivedDefaults(criteria), idemRef.current, version),
      WRITE_TIMEOUT_MS,
    );
    setBusy(null);
    if ("timedOut" in res) {
      toast.error("That took too long. Try again, it will not save twice.");
      return;
    }
    if (!res.ok) {
      if (res.kind === "conflict") {
        toast.error("You set this up on another device. Opening it.");
        router.replace("/settings");
        return;
      }
      toast.error(res.kind === "auth" ? "Your session expired. Sign in and try again." : res.message);
      return;
    }
    idemRef.current = crypto.randomUUID();
    // `replace`, not `push`: Back out of a finished setup should not land on the
    // last step of a wizard that has nothing left to do.
    router.replace("/queue");
  }

  const zero = preview.kind === "ready" && preview.preview.qualified === 0;
  /**
   * The one thing this cannot be finished without.
   *
   * Everything else on both screens has a default that works. The role does
   * not: it is read into the tagger's prompt verbatim and it is what the title
   * list is derived from, so without it the queue is empty by construction —
   * which on day one reads as a broken product rather than as a blank field.
   */
  const answerable = describesASearch(withDerivedDefaults(criteria));

  return (
    <div
      className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 pb-40 pt-6 sm:px-6"
      data-testid="wizard"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <header>
        <p className="text-xs text-muted" data-testid="step-label">
          Step {step} of {LAST_STEP}
        </p>
        <h1
          ref={headingRef}
          tabIndex={-1}
          data-testid="step-heading"
          className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {STEP_TITLES[step]}
        </h1>
        {step === FIRST_STEP ? (
          // The time promise, which every one of these flows makes up front
          // ("Your best matches are 3 minutes away!"). Ours can be literal,
          // because there really are only two screens.
          <p className="mt-1 text-sm text-muted">
            Two short questions. You can change any of it later.
          </p>
        ) : null}
      </header>

      {step === 1 ? (
        <div className="space-y-4">
          <div>
            <label htmlFor="role_family" className="block text-xs font-medium text-text-2">
              The job you want
            </label>
            <input
              id="role_family"
              value={criteria.role_family}
              // No `autoFocus`: the step effect focuses the HEADING, which is
              // what a screen reader announces when the step changes (matrix row
              // 94). Two things claiming focus on mount is one of them losing.
              placeholder="nurse practitioner"
              onChange={(e) => setRole(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            />
            <p className="mt-1 text-xs text-muted">
              A job title or a couple of words. Everything below fills itself in
              from this, and you can change any of it.
            </p>
          </div>

          <ChipList
            id="titles_include"
            label="Show me postings whose title contains"
            values={criteria.titles_include}
            onChange={(v) => patch({ titles_include: v })}
            placeholder="add another title"
          />
          <ChipList
            id="titles_exclude"
            label="Skip postings whose title contains"
            values={criteria.titles_exclude}
            onChange={(v) => patch({ titles_exclude: v })}
            placeholder="intern"
          />
          {/* The example this line used to carry was "Product Marketing Manager
              out of a search for product managers", which is the framing
              complaint in miniature: a nurse read a sentence about product
              management on her own setup screen. */}
          <p className="text-xs text-muted">
            Skips win. A word on the second list keeps the posting out even when
            its title also matches the first.
          </p>

          {/* Templates, at the bottom and small. These two lists are the only
              ones anybody has tuned against a live feed, so they are worth
              offering — but offering them FIRST told every other kind of worker
              that this app was not built for them, which is the owner's
              complaint about step one. */}
          <div className="pt-2" data-testid="templates">
            <p className="text-xs text-muted">Or start from a tuned list:</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {TEMPLATES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`template-${p.id}`}
                  onClick={() => setCriteria(draftFromPreset(p.id))}
                  className="rounded-md border border-dashed border-border-strong px-2 py-1 text-xs text-text-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {step === LAST_STEP ? (
        <div className="space-y-4">
          <ChipList
            id="metros"
            label="Cities"
            values={criteria.metros}
            onChange={(v) => patch({ metros: v })}
            placeholder="Chicago"
            suggestions={METRO_NAMES}
          />
          <p className="text-xs text-muted">
            Leave this empty to search the whole country. Remote postings come
            through either way.
          </p>

          <MoneyField
            id="comp_min"
            label="Lowest pay you want to see"
            dollars={dollarsFromK(criteria.comp_min)}
            hint="Leave it empty to see every salary. Read off the top of a published band."
            onChange={(d) => patch({ comp_min: kFromDollars(d) })}
          />

          <ChipList
            id="work_model_exclude"
            label="Ways of working to rule out"
            values={criteria.work_model_exclude}
            onChange={(v) => patch({ work_model_exclude: v })}
            placeholder="onsite"
            suggestions={["onsite", "hybrid"]}
          />

          {/* Everything the engine needs and nobody asked about. Shipped with
              the defaults two real profiles run on, closed, and reachable. Six
              screens of these is what made setup feel like paperwork. */}
          <details className="rounded-md border border-border p-3" data-testid="advanced">
            <summary className="cursor-pointer text-sm font-medium">
              More filters
            </summary>
            <div className="mt-3 space-y-4">
              <ChipList
                id="countries"
                label="Countries"
                values={criteria.countries}
                onChange={(v) => patch({ countries: v })}
                placeholder="United States"
              />
              <PolicyChoice
                name="geo_unknown"
                legend="Postings we cannot place on a map"
                value={criteria.geo_unknown}
                options={[
                  {
                    value: "filter",
                    label: "Skip them",
                    body: "A posting nobody could place is probably not near you.",
                  },
                  {
                    value: "keep",
                    label: "Include them",
                    body: "You would rather check a few by hand than miss one.",
                  },
                ]}
                onChange={(v) => patch({ geo_unknown: v })}
              />

              <NumberField
                id="yoe_max"
                label="Most years of experience a posting may ask for"
                value={criteria.yoe_max}
                min={0}
                max={MAX_YOE}
                suffix="years"
                onChange={(n) => patch({ yoe_max: n })}
              />
              <PolicyChoice
                name="yoe_unknown"
                legend="Postings that name no number of years"
                value={criteria.yoe_unknown}
                options={[
                  {
                    value: "seniority-proxy",
                    label: "Judge them by level",
                    body: "Read Senior, Staff or Director as a stand-in for the years the posting left out.",
                  },
                  {
                    value: "keep",
                    label: "Include them",
                    body: "Pick this on a finance or operations ladder. Director there is a job you want, and the stand-in reads it as one you have outgrown.",
                  },
                ]}
                onChange={(v) => patch({ yoe_unknown: v })}
              />
              {criteria.yoe_unknown === "seniority-proxy" ? (
                <ChipList
                  id="seniority_exclude"
                  label="Levels to rule out"
                  values={criteria.seniority_exclude}
                  onChange={(v) => patch({ seniority_exclude: v })}
                  placeholder="Director"
                  suggestions={["Senior", "Staff", "GPM", "Director", "VP"]}
                />
              ) : null}

              <PolicyChoice
                name="comp_unknown"
                legend="Postings with no salary listed"
                value={criteria.comp_unknown}
                options={[
                  {
                    value: "keep",
                    label: "Include them",
                    body: "About half of live postings name no number. Skipping those empties most of the feed.",
                  },
                  {
                    value: "filter",
                    label: "Skip them",
                    body: "Fewer postings, every one with a salary attached.",
                  },
                ]}
                onChange={(v) => patch({ comp_unknown: v })}
              />

              <div>
                <label
                  htmlFor="board_search_term"
                  className="block text-xs font-medium text-text-2"
                >
                  Keyword for the big shared boards
                </label>
                <input
                  id="board_search_term"
                  value={criteria.board_search_term}
                  placeholder={boardTermFromRole(criteria.role_family)}
                  onChange={(e) => patch({ board_search_term: e.target.value })}
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                />
                <p className="mt-1 text-xs text-muted">
                  Workday and boards like it have no company list to walk, so we
                  search them by one word.
                </p>
              </div>
            </div>
          </details>

          {/* The numbers, under the questions rather than one screen further on.
              As a step of its own this read as a checkpoint to get past; here it
              is the answer to what you just typed. */}
          <div className="space-y-3 pt-2">
            <h2 className="text-sm font-semibold">What this finds today</h2>
            <PreviewPanel
              state={preview}
              onGoToSetting={(setting) => {
                // The constraint's name goes back to the step that owns it,
                // rather than to an anchor on a page that is not open.
                const target = stepForSetting(setting);
                if (target === step) return;
                go(target);
              }}
            />
            {preview.kind === "stale" || preview.kind === "failed" ? (
              <Button
                type="button"
                onClick={() => check()}
                disabled={busy !== null}
                data-testid="check-button"
              >
                {busy === "check" ? "Checking…" : "Check again"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {tooLong ? (
        <p
          className="rounded-md border border-warn p-2 text-sm"
          data-testid="draft-too-long"
          role="status"
        >
          These answers are too long to carry in the address bar, which is where
          they live so that a refresh and a Back both work. Nothing is lost.
          Shorten or remove a few of the longest entries and carry on.
        </p>
      ) : null}

      {!answerable ? (
        // Said beside the button rather than after pressing it: a disabled
        // control with no explanation is its own dead end.
        <p className="text-xs text-warn" data-testid="step-blocker" role="status">
          Tell us the job you want first. One or two words is enough.
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {step > FIRST_STEP ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => go(step - 1)}
            data-testid="back-button"
          >
            Back
          </Button>
        ) : null}

        {step < LAST_STEP ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => go(step + 1)}
            disabled={!answerable || tooLong}
            data-testid="next-button"
          >
            Next
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            onClick={save}
            // Refused until the check has answered, with the same reasoning as
            // /settings and more force here: this is somebody's first day, and
            // an empty queue on day one reads as "the product does not work".
            disabled={
              busy !== null || !answerable || preview.kind === "idle" || preview.kind === "running"
            }
            data-testid="finish-button"
          >
            {busy === "save" ? "Saving…" : zero ? "Finish anyway" : "Finish"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Which step owns a `reasonSetting()` key, for the binding constraint's link. */
function stepForSetting(setting: string | undefined): number {
  switch (setting) {
    case "titlesInclude":
    case "titlesExclude":
    case "roleFamily":
      return 1;
    default:
      // Everything the preview can name — countries, metros, yoeMax,
      // seniorityExclude, compMin, workModelExclude — is on the last step, four
      // of them inside the disclosure.
      return LAST_STEP;
  }
}
