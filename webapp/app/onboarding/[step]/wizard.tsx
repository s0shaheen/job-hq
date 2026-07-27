"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { METRO_NAMES } from "@/lib/profile/metros";
import {
  MAX_COMP_MIN_K,
  MAX_YOE,
  type ProfileCriteria,
} from "@/lib/profile/criteria";
import { draftFromPreset, presetFor, ROLE_PRESETS } from "@/lib/profile/presets";
import { encodeDraft, DRAFT_PARAM, FIRST_STEP, LAST_STEP } from "@/lib/profile/draft";
import { ChipList, NumberField, PolicyChoice } from "../../(app)/settings/fields";
import { PreviewPanel, type PreviewState } from "../../(app)/settings/preview-panel";
import { commitProfileAction, previewProfileAction } from "../../(app)/settings/actions";

/**
 * The six-step wizard. Same fields as `/settings`, the same two server actions,
 * one question at a time.
 *
 * The step machinery is the only thing new here, and the reason for six screens
 * rather than one long form is the unknown-handling policies. `geo_unknown`,
 * `yoe_unknown` and `comp_unknown` are three abstract radio groups; collected
 * together on an "advanced" page they are where a non-technical user clicks
 * Next without reading. Asked next to the field they modify, each is a
 * sentence.
 *
 * Step 6 is the preview and it cannot be skipped — "Back to change something"
 * is exactly as prominent as "Looks right", because a profile nobody has seen
 * the consequences of is the silent empty queue this whole phase exists for.
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

/**
 * What a step still needs before Next means anything, or null.
 *
 * The wizard used to accept "Something else" with every field blank and store a
 * product-management search under the person's name, because `parseCriteria`
 * filled the three empty strings in from `BASE_CRITERIA`. That fallback is gone
 * (a deliberate empty string now survives), which turns the silent lie into an
 * unanswerable profile — so the wizard has to ask rather than guess.
 *
 * Only the two fields the ENGINE cannot work without are gated: `role_family`
 * is what the tagger is told it is reading, and `titles_include` is what the
 * sweep matches a posting's title against. An empty include list matches
 * NOTHING, so a profile without one produces an empty queue by construction —
 * which is the exact failure this whole phase exists to remove.
 */
function stepBlocker(step: number, c: ProfileCriteria): string | null {
  if (step === 1 && !c.role_family.trim()) {
    return "Name the kind of role you are looking for — the classifier is told those words verbatim.";
  }
  if (step === 1 && !c.board_search_term.trim()) {
    return "Add a search word for the big shared boards (Workday and friends search by keyword).";
  }
  if (step === 2 && c.titles_include.length === 0) {
    return "Add at least one job title. A posting reaches you when its title contains one of these, so an empty list matches nothing.";
  }
  return null;
}

const STEP_TITLES: Record<number, string> = {
  1: "What kind of role?",
  2: "Which job titles?",
  3: "Where?",
  4: "How much experience?",
  5: "Pay and work model",
  6: "What this would find",
};

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
  const checkedRef = React.useRef<string | null>(null);
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
  // without this, Back to step 2 shows the answers as they are NOW.
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
    checkedRef.current = null;
  }

  async function check() {
    setBusy("check");
    setPreview({ kind: "running" });
    const res = await withTimeout(previewProfileAction(criteria), WRITE_TIMEOUT_MS);
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
    checkedRef.current = "done";
    setPreview({ kind: "ready", preview: res.preview });
  }

  // Step 6 runs the check on arrival: the whole point of the step is the
  // number, and making somebody press a button to see the thing they navigated
  // to is a step that looks broken.
  React.useEffect(() => {
    if (step !== LAST_STEP) return;
    if (preview.kind !== "idle") return;
    void check();
    // `criteria` is deliberately not a dependency: an edit on this step marks
    // the preview stale and the user re-runs it, which is row 95's behaviour.
    // Re-running on every keystroke would be an unbounded fan-out of writes'
    // worth of work for a number nobody asked to recompute yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, preview.kind]);

  async function save() {
    setBusy("save");
    // `tag_domain` falls back to the role family — which is what the field's
    // PLACEHOLDER showed, so the stored value is the one the screen promised.
    // Nothing else is filled in: the other two are gated on step 1.
    const toSave: ProfileCriteria = {
      ...criteria,
      tag_domain: criteria.tag_domain.trim() || criteria.role_family.trim(),
    };
    const res = await withTimeout(
      commitProfileAction(toSave, idemRef.current, version),
      WRITE_TIMEOUT_MS,
    );
    setBusy(null);
    if ("timedOut" in res) {
      toast.error("That took too long. Try again — it will not save twice.");
      return;
    }
    if (!res.ok) {
      if (res.kind === "conflict") {
        toast.error("Your profile was set up on another device. Opening it.");
        router.replace("/settings");
        return;
      }
      toast.error(res.kind === "auth" ? "Your session expired. Sign in and try again." : res.message);
      return;
    }
    idemRef.current = crypto.randomUUID();
    // `replace`, not `push`: Back out of a finished setup should not land on
    // step 6 of a wizard that has nothing left to do.
    router.replace("/queue");
  }

  const zero = preview.kind === "ready" && preview.preview.qualified === 0;
  const activePreset = presetFor(criteria);
  const blocker = stepBlocker(step, criteria);

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
      </header>

      {step === 1 ? (
        <fieldset className="space-y-2">
          <legend className="sr-only">Role family</legend>
          {ROLE_PRESETS.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
                activePreset.id === p.id ? "border-accent bg-accent-subtle" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="preset"
                value={p.id}
                checked={activePreset.id === p.id}
                onChange={() => patch(draftFromPreset(p.id))}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="min-w-0">
                <span className="block font-medium">{p.label}</span>
                <span
                  className={`block text-xs ${activePreset.id === p.id ? "text-text-2" : "text-muted"}`}
                >
                  {p.blurb}
                </span>
              </span>
            </label>
          ))}
          <div className="space-y-3 pt-2">
            <div>
              <label htmlFor="role_family" className="block text-xs font-medium text-text-2">
                Describe it in your own words
              </label>
              <input
                id="role_family"
                value={criteria.role_family}
                placeholder="financial planning &amp; analysis"
                onChange={(e) => patch({ role_family: e.target.value })}
                className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              />
              <p className="mt-1 text-xs text-muted">
                The classifier is told these words verbatim when it reads a posting.
              </p>
            </div>
            {/* Asked, not guessed. A preset fills both of these; "Something else"
                leaves them empty, and the wizard used to store the
                product-management values in their place without saying so. */}
            <div>
              <label
                htmlFor="board_search_term"
                className="block text-xs font-medium text-text-2"
              >
                One word to search the big shared boards for
              </label>
              <input
                id="board_search_term"
                value={criteria.board_search_term}
                placeholder="financial"
                onChange={(e) => patch({ board_search_term: e.target.value })}
                className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              />
              <p className="mt-1 text-xs text-muted">
                Workday and the other corpus-wide boards have no company list to
                walk, so they are searched by keyword.
              </p>
            </div>
            <div>
              <label htmlFor="tag_domain" className="block text-xs font-medium text-text-2">
                Domain label for the classifier (optional)
              </label>
              <input
                id="tag_domain"
                value={criteria.tag_domain}
                placeholder={criteria.role_family || "finance"}
                onChange={(e) => patch({ tag_domain: e.target.value })}
                className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              />
              <p className="mt-1 text-xs text-muted">
                Left blank, the words above are used — which is what the
                placeholder shows.
              </p>
            </div>
          </div>
        </fieldset>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            A posting reaches you if its title contains one of the first list and
            none of the second. Excludes always win — that is what keeps “Product
            Marketing Manager” out of a product-management search.
          </p>
          <ChipList
            id="titles_include"
            label="Titles to include"
            values={criteria.titles_include}
            onChange={(v) => patch({ titles_include: v })}
            placeholder="product manager"
          />
          <ChipList
            id="titles_exclude"
            label="Titles to exclude"
            values={criteria.titles_exclude}
            onChange={(v) => patch({ titles_exclude: v })}
            placeholder="product marketing"
          />
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <ChipList
            id="countries"
            label="Countries"
            values={criteria.countries}
            onChange={(v) => patch({ countries: v })}
            placeholder="United States"
          />
          <ChipList
            id="metros"
            label="Metros — leave empty for a nationwide search"
            values={criteria.metros}
            onChange={(v) => patch({ metros: v })}
            placeholder="Chicago"
            suggestions={METRO_NAMES}
          />
          <p className="text-xs text-muted">
            Naming a metro narrows to a local search. Remote roles still come
            through, because they are not tied to a place.
          </p>
          <PolicyChoice
            name="geo_unknown"
            legend="When a posting’s location cannot be identified"
            value={criteria.geo_unknown}
            options={[
              {
                value: "filter",
                label: "Filter it out",
                body: "A posting nobody could place is probably not near you.",
              },
              {
                value: "keep",
                label: "Show it anyway",
                body: "You would rather check a few by hand than miss one.",
              },
            ]}
            onChange={(v) => patch({ geo_unknown: v })}
          />
        </div>
      ) : null}

      {step === 4 ? (
        <div className="space-y-4">
          <NumberField
            id="yoe_max"
            label="Most years a posting may ask for"
            value={criteria.yoe_max}
            min={0}
            max={MAX_YOE}
            suffix="years"
            onChange={(n) => patch({ yoe_max: n })}
          />
          <PolicyChoice
            name="yoe_unknown"
            legend="When a posting states no years at all"
            value={criteria.yoe_unknown}
            options={[
              {
                value: "seniority-proxy",
                label: "Judge it by seniority",
                body: "Use the posting’s level (Senior, Staff, Director…) as a stand-in for the years it did not state.",
              },
              {
                value: "keep",
                label: "Show it",
                body: "Right for a finance or operations ladder, where “Director” is a target rather than a level above you — the seniority stand-in is tuned for product titles and gets those backwards.",
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
        </div>
      ) : null}

      {step === 5 ? (
        <div className="space-y-4">
          <NumberField
            id="comp_min"
            label="Minimum pay, in thousands"
            value={criteria.comp_min}
            min={0}
            max={MAX_COMP_MIN_K}
            suffix="$k · 0 turns this off"
            onChange={(n) => patch({ comp_min: n })}
          />
          <PolicyChoice
            name="comp_unknown"
            legend="When a posting publishes no pay at all"
            value={criteria.comp_unknown}
            options={[
              {
                value: "keep",
                label: "Show it",
                body: "About half of live postings state nothing. Filtering them deletes most of the feed, which is why this is the default.",
              },
              {
                value: "filter",
                label: "Filter it out",
                body: "Fewer postings, all of them with a number attached.",
              },
            ]}
            onChange={(v) => patch({ comp_unknown: v })}
          />
          <ChipList
            id="work_model_exclude"
            label="Work models to rule out"
            values={criteria.work_model_exclude}
            onChange={(v) => patch({ work_model_exclude: v })}
            placeholder="onsite"
            suggestions={["onsite", "hybrid"]}
          />
        </div>
      ) : null}

      {step === LAST_STEP ? (
        <div className="space-y-3">
          <PreviewPanel
            state={preview}
            onGoToSetting={() => {
              // On the wizard the constraint's name goes BACK to the step that
              // owns it, rather than to an anchor on a page that is not open.
              // Same intent as /settings, different geography.
              go(stepForSetting(preview.kind === "ready" ? preview.preview.binding?.setting : undefined));
            }}
          />
          {preview.kind === "stale" || preview.kind === "failed" ? (
            <Button type="button" onClick={check} disabled={busy !== null} data-testid="check-button">
              {busy === "check" ? "Checking…" : "Check again"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {tooLong ? (
        <p
          className="rounded-md border border-warn p-2 text-sm"
          data-testid="draft-too-long"
          role="status"
        >
          These answers are too long to carry in the address bar, which is where
          the wizard keeps them so a refresh and Back both work. Nothing has been
          lost — shorten or remove a few of the longest entries and you can carry
          on.
        </p>
      ) : null}

      {blocker ? (
        // Said beside the button rather than after pressing it: a disabled
        // control with no explanation is its own dead end (the /settings Save
        // button's rule, on a surface where there is nowhere else to go).
        <p className="text-xs text-warn" data-testid="step-blocker" role="status">
          {blocker}
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
            {step === LAST_STEP ? "Back to change something" : "Back"}
          </Button>
        ) : null}

        {step < LAST_STEP ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => go(step + 1)}
            disabled={blocker !== null || tooLong}
            data-testid="next-button"
          >
            Next
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            onClick={save}
            // Refused until the check has answered — with the same reasoning as
            // /settings, and more force here: this is somebody's first day, and
            // an empty queue on day one reads as "the product does not work".
            disabled={busy !== null || preview.kind === "idle" || preview.kind === "running"}
            data-testid="finish-button"
          >
            {busy === "save" ? "Saving…" : zero ? "Save anyway" : "Looks right — start"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Which step owns a `reasonSetting()` key, for the binding constraint's link. */
function stepForSetting(setting: string | undefined): number {
  switch (setting) {
    case "countries":
    case "metros":
      return 3;
    case "yoeMax":
    case "seniorityExclude":
      return 4;
    case "compMin":
    case "workModelExclude":
      return 5;
    default:
      return 2;
  }
}
