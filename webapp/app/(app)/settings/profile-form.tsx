"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { METRO_NAMES } from "@/lib/profile/metros";
import {
  BASE_CRITERIA,
  describesASearch,
  MAX_YOE,
  unknownMetros,
  type ProfileCriteria,
} from "@/lib/profile/criteria";
import { dollarsFromK, kFromDollars } from "@/lib/profile/money";
import { ChipList, MoneyField, NumberField, PolicyChoice, Section } from "./fields";
import { PreviewPanel, type PreviewState } from "./preview-panel";
import { commitProfileAction, previewProfileAction } from "./actions";

/**
 * The Search Profile, editable, with the dry run in front of the save.
 *
 * The order of the two buttons is the design. Nothing here can be saved until
 * it has been CHECKED against real postings, because the failure this whole
 * phase exists to remove is silent: a wrong `metros` or `yoe_max` produces an
 * empty queue, an empty queue looks exactly like a quiet week, and nobody finds
 * out for a fortnight. Every other mistake in this app announces itself.
 *
 * So: edit → "Check what this would let through" → numbers → "Save". Editing
 * anything after a check marks the numbers stale and the primary button goes
 * back to Check. That is matrix row 95 — a number computed against settings
 * that have since changed is worse than no number, because it looks current.
 */

/** A bound on the server action, matching every other write on this app. */
const WRITE_TIMEOUT_MS = 15_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { timedOut: true }> {
  // The house rule that cost three outages in a day: every external call gets a
  // bound. An unbounded action here strands the form disabled forever with
  // "Saving…" on screen and no way back (matrix row 135).
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

/** Stable identity for a criteria object — what "the preview is stale" means. */
function fingerprint(c: ProfileCriteria): string {
  return JSON.stringify([
    c.role_family,
    c.titles_include,
    c.titles_exclude,
    c.countries,
    c.metros,
    c.geo_unknown,
    c.yoe_max,
    c.yoe_unknown,
    c.seniority_exclude,
    c.comp_min,
    c.comp_unknown,
    c.work_model_exclude,
  ]);
}

export type CommitBanner = {
  restamped: number;
  newlyQualified: number;
};

export default function ProfileForm({
  initial,
  version,
}: {
  initial: ProfileCriteria;
  /** `profiles.updated_at` as the server last read it — the conflict token. */
  version: string | null;
}) {
  const router = useRouter();
  const [criteria, setCriteria] = React.useState<ProfileCriteria>(initial);
  const [preview, setPreview] = React.useState<PreviewState>({ kind: "idle" });
  const [busy, setBusy] = React.useState<null | "check" | "save">(null);
  const [banner, setBanner] = React.useState<CommitBanner | null>(null);
  /** The criteria the current preview was computed for. */
  const checkedRef = React.useRef<string | null>(null);
  /**
   * One key per SAVE GESTURE, reused by every retry of it.
   *
   * Matrix row 136: minting a fresh uuid per attempt makes "double-tap is free"
   * false — a request whose RESPONSE was lost applies a second time against an
   * append-only trail. A new key is minted only after a save lands.
   */
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

  const fp = fingerprint(criteria);
  const fresh = checkedRef.current === fp;

  // Mark an existing preview stale the moment anything changes under it.
  React.useEffect(() => {
    setPreview((p) => {
      if (p.kind === "ready" && checkedRef.current !== fp) return { kind: "stale", preview: p.preview };
      if (p.kind === "stale" && checkedRef.current === fp) return { kind: "ready", preview: p.preview };
      return p;
    });
  }, [fp]);

  function patch(next: Partial<ProfileCriteria>) {
    setCriteria((c) => ({ ...c, ...next }));
    setBanner(null);
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
    checkedRef.current = fingerprint(criteria);
    setPreview({ kind: "ready", preview: res.preview });
  }

  async function save() {
    setBusy("save");
    const res = await withTimeout(
      commitProfileAction(criteria, idemRef.current, version),
      WRITE_TIMEOUT_MS,
    );
    setBusy(null);

    if ("timedOut" in res) {
      // The write may still land, and its idempotency key makes that safe —
      // which is exactly why the key is NOT rotated here.
      toast.error("That took too long. Try again, it will not save twice.");
      return;
    }
    if (!res.ok) {
      if (res.kind === "conflict") {
        toast.error("Your profile changed on another device. Showing the latest.");
        router.refresh();
        return;
      }
      toast.error(res.kind === "auth" ? "Your session expired. Sign in and try again." : res.message);
      return;
    }

    idemRef.current = crypto.randomUUID();
    setBanner({ restamped: res.restamped, newlyQualified: res.newlyQualifiedKeys.length });
    toast.success("Search profile saved.");
    router.refresh();
  }

  function goToSetting(setting: string) {
    const el = document.getElementById(setting);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // Focus the heading, not the section: a heading is what a screen reader
    // announces, and moving focus is the only way this navigation exists at all
    // for somebody not watching the scroll.
    const heading = document.getElementById(`${setting}-heading`);
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
  }

  const zero = preview.kind === "ready" && preview.preview.qualified === 0;
  // Same rule as the wizard's step gate, for the same reason: `parseCriteria` no
  // longer fills an empty role family or title list in from the committed
  // baseline, so an unanswerable profile is now a state that can be SAVED unless
  // something says no. It is said out loud rather than hidden behind a disabled
  // button (matrix row 97's shape — a control that always errors is worse than
  // none).
  const answerable = describesASearch(criteria);

  return (
    // `pb-40`: the toast sits bottom-centre and this page is close to one screen
    // on a phone, so without a safe area the confirmation covers the button that
    // produced it (matrix row 100).
    <div
      className="mx-auto max-w-2xl space-y-3 px-4 pb-40 pt-5 sm:px-6"
      data-testid="profile-form"
      data-hydrated={hydrated ? "true" : "false"}
    >
      {banner ? (
        <div
          className="rounded-lg border border-accent bg-accent-subtle p-3 text-sm"
          data-testid="commit-banner"
          data-newly-qualified={banner.newlyQualified}
          // What the SERVER said it did. Published as an attribute because it is
          // the only thing that distinguishes one applied commit from two: a
          // replayed key returns the first call's counts, and a second gesture
          // with a fresh key returns zeros, because the rows already moved.
          data-restamped={banner.restamped}
          role="status"
        >
          {banner.newlyQualified > 0 ? (
            <>
              <strong>
                {banner.newlyQualified}{" "}
                {banner.newlyQualified === 1 ? "posting we had skipped" : "postings we had skipped"}{" "}
                {banner.newlyQualified === 1 ? "now qualifies" : "now qualify"}.
              </strong>{" "}
              They are in your queue.{" "}
              {/* PHASE-PROFILE wants `/jobs?keys=…` from the event payload. The
                  grid has no `keys` filter and adding one is a change to the URL
                  grammar with its own round-trip guarantees, so this links to the
                  queue working set — which contains exactly the untriaged
                  qualified rows, plus the ones that already were. The plan
                  sanctions the interim ("until then the banner links to a
                  filtered queue"); what is NOT done is pre-selecting them. */}
              <span className="inline-flex items-center gap-2">
                <Link href="/jobs?set=queue" className="underline underline-offset-2">
                  Review them
                </Link>
                <button
                  type="button"
                  onClick={() => setBanner(null)}
                  className="underline underline-offset-2"
                >
                  Not now
                </button>
              </span>
            </>
          ) : (
            <>
              Saved. {banner.restamped === 0
                ? "Nothing in your current set changed."
                : `${banner.restamped} ${banner.restamped === 1 ? "posting" : "postings"} re-checked.`}{" "}
              <button
                type="button"
                onClick={() => setBanner(null)}
                className="underline underline-offset-2"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      ) : null}

      <Section
        id="roleFamily"
        title="What you are looking for"
        blurb="The job you want, and the words we match a posting's title against."
      >
        <div className="space-y-3">
          {!answerable ? (
            <p
              className="rounded-md border border-warn p-2 text-sm"
              data-testid="unanswerable-warning"
              role="status"
            >
              This profile does not say what job you want yet. Fill in the role
              and at least one title. A posting reaches you when its title
              contains one of them, so an empty list finds nothing.
            </p>
          ) : null}
          <div>
            <label htmlFor="role_family" className="block text-xs font-medium text-text-2">
              The job you want
            </label>
            <input
              id="role_family"
              value={criteria.role_family}
              onChange={(e) => patch({ role_family: e.target.value })}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            />
          </div>
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
              onChange={(e) => patch({ board_search_term: e.target.value })}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            />
            <p className="mt-1 text-xs text-muted">
              Workday and boards like it have no company list to walk, so we
              search them by one word.
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
          <p className="text-xs text-muted">
            Skips win. A word on the second list keeps the posting out even when
            its title also matches the first.
          </p>
        </div>
      </Section>

      <Section
        id="countries"
        title="Countries"
        blurb="Where a posting may be based. Anywhere else gets skipped."
      >
        <div className="space-y-3">
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
                body: "A posting nobody could place is probably not near you. This is the default.",
              },
              {
                value: "keep",
                label: "Include them",
                body: "You would rather check a few by hand than miss one. This also covers postings inside your countries that no city could be matched to.",
              },
            ]}
            onChange={(v) => patch({ geo_unknown: v })}
          />
        </div>
      </Section>

      <Section
        id="metros"
        title="Cities"
        blurb="Add every city you would commute to. Leave it empty to search the whole country. Remote postings come through either way."
      >
        <div className="space-y-3">
          {/* The warning `unknownMetros`'s doc comment has always promised, which
              nothing rendered — the function was exported, documented and called
              by nothing, which is the same defect as a button that does nothing.
              A metro the engine cannot produce matches NOTHING: `dispose`
              compares `geo.metro` against this list with `==`, so a typo here is
              a filter that silently removes everything. */}
          {unknownMetros(criteria).length > 0 ? (
            <p
              className="rounded-md border border-warn p-2 text-sm"
              data-testid="unknown-metros-warning"
              role="status"
            >
              No scanned location matches {unknownMetros(criteria).join(", ")}. Cities are
              matched against a fixed list, so a name that is not on it finds
              nothing. Pick one from the suggestions below, or clear the box to
              search the whole country.
            </p>
          ) : null}
          <ChipList
            id="metros"
            label="Cities you would work in"
            values={criteria.metros}
            onChange={(v) => patch({ metros: v })}
            placeholder="Chicago"
            suggestions={METRO_NAMES}
          />
        </div>
      </Section>

      <Section
        id="yoeMax"
        title="Experience limit"
        blurb="The most years a posting may ask for and still reach you."
      >
        <div className="space-y-3">
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
            legend="Postings that name no number of years"
            value={criteria.yoe_unknown}
            options={[
              {
                value: "seniority-proxy",
                label: "Judge them by level",
                body: "Read Senior, Staff or Director as a stand-in for the years the posting left out, then apply the levels ruled out below.",
              },
              {
                value: "keep",
                label: "Include them",
                body: "Pick this on a finance or operations ladder. Director there is a job you want, and the stand-in reads it as one you have outgrown.",
              },
            ]}
            onChange={(v) => patch({ yoe_unknown: v })}
          />
        </div>
      </Section>

      <Section
        id="seniorityExclude"
        title="Levels ruled out"
        blurb="Used only when a posting names no years and the level stand-in is on."
      >
        <ChipList
          id="seniority_exclude"
          label="Levels to rule out"
          values={criteria.seniority_exclude}
          onChange={(v) => patch({ seniority_exclude: v })}
          placeholder="Director"
          suggestions={["Senior", "Staff", "GPM", "Director", "VP"]}
        />
      </Section>

      <Section
        id="compMin"
        title="Pay floor"
        blurb="Read off the top of a published band, so a $110k to $160k posting clears a $120,000 floor."
      >
        <div className="space-y-3">
          <MoneyField
            id="comp_min"
            label="Lowest pay you want to see"
            dollars={dollarsFromK(criteria.comp_min)}
            // Otta's line, and it earns its place: over-anchoring here is the
            // one way this field quietly empties a queue.
            hint="Leave it empty to see every salary. If you are unsure, pick a lower number. A high floor hides roles you would have taken."
            onChange={(d) => patch({ comp_min: kFromDollars(d) })}
          />
          <PolicyChoice
            name="comp_unknown"
            legend="Postings with no salary listed"
            value={criteria.comp_unknown}
            options={[
              {
                value: "keep",
                label: "Include them",
                body: "About half of live postings name no number. Skipping those empties most of the feed, which is why this is the default.",
              },
              {
                value: "filter",
                label: "Skip them",
                body: "Fewer postings, every one with a salary attached. Expect about half as many.",
              },
            ]}
            onChange={(v) => patch({ comp_unknown: v })}
          />
        </div>
      </Section>

      <Section
        id="workModelExclude"
        title="Ways of working"
        blurb="Matched against the work model a posting states, whatever its capitalisation."
      >
        <ChipList
          id="work_model_exclude"
          label="Ways of working to rule out"
          values={criteria.work_model_exclude}
          onChange={(v) => patch({ work_model_exclude: v })}
          placeholder="onsite"
          suggestions={["onsite", "hybrid"]}
        />
      </Section>

      <div className="space-y-3 pt-2">
        <h2 className="text-sm font-semibold">Before you save</h2>
        <PreviewPanel state={preview} onGoToSetting={goToSetting} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={fresh ? "secondary" : "primary"}
            onClick={check}
            disabled={busy !== null}
            data-testid="check-button"
          >
            {busy === "check" ? "Checking" : fresh ? "Check again" : "Check what this finds"}
          </Button>
          <Button
            type="button"
            variant={fresh ? "primary" : "secondary"}
            onClick={save}
            // Not disabled when stale — disabled buttons with no explanation are
            // their own dead end. It is de-emphasised, and the panel above says
            // in words why. What IS refused is saving with no check at all.
            disabled={busy !== null || preview.kind === "idle" || !answerable}
            data-testid="save-button"
          >
            {busy === "save" ? "Saving" : zero ? "Save anyway" : "Save profile"}
          </Button>
          {preview.kind === "idle" ? (
            <span className="text-xs text-muted">Check first. It writes nothing.</span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => {
            setCriteria({ ...BASE_CRITERIA, role_family: criteria.role_family });
            setBanner(null);
          }}
          className="text-xs text-muted underline underline-offset-2"
        >
          Reset the filters to their defaults
        </button>
      </div>
    </div>
  );
}
