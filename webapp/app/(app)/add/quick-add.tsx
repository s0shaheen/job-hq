"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button, LogoAvatar } from "@/components/ds";
import type { ResolvedLink } from "@/lib/data/source";
import { applyDraftEdit } from "@/lib/quickadd/draft";
import { addJobAction, resolveLinksAction } from "./actions";

/**
 * Quick add — the owner's composition
 * (`templates/system-surfaces/SystemSurfaces.dc.html`, the `add a job`,
 * `parsing`, `add several` and `parse failure` frames).
 *
 * Four things this surface refuses to do, each of them a way the legacy lane
 * or a plausible rewrite gets it wrong:
 *
 *   1. **It never silently accepts a parse.** Every extracted field is on
 *      screen, in an editable box, beside a line saying where it was read.
 *      `tracker/quickadd.py` asked a model for five fields and appended the
 *      answer, so a confident misreading became a row nobody reviewed. Here
 *      the parse is a proposal.
 *   2. **It never guesses.** An unreadable posting produces an empty form with
 *      the URL kept and the owner's own sentence — "Couldn't read this
 *      posting. The link is saved; details fill in on the next scan." — not a
 *      title reverse-engineered out of a URL slug.
 *   3. **It never creates a second row for a posting already tracked.** The
 *      duplicate is named, with a way to open the one that exists.
 *   4. **It never queues a write while offline.** There is no offline mutation
 *      queue in this product, so the control disables and says why, which is
 *      the honest rendering of a write path that settles on the server.
 *
 * The debounce is not decoration: the resolve step fetches somebody else's
 * website, so it fires when typing settles rather than per keystroke.
 */

const DEBOUNCE_MS = 600;

type Draft = ResolvedLink & {
  /** Minted once per row and REUSED on every retry — that is what makes the
   *  write idempotent. A fresh key per attempt would add the job twice. The
   *  ONE exception is an edit after a failed attempt: the edited row is a new
   *  gesture, and `lib/quickadd/draft.ts` states why reusing the key there is
   *  refused by the database (22023) rather than merely wrong. */
  idem: string;
  company_: string;
  title_: string;
  outcome: "pending" | "added" | "duplicate" | "failed";
};

function draftFrom(link: ResolvedLink): Draft {
  return {
    ...link,
    idem: crypto.randomUUID(),
    company_: link.company?.value ?? "",
    title_: link.title?.value ?? "",
    outcome: link.duplicate ? "duplicate" : "pending",
  };
}

/** The provenance line. Absent facts are named as absent, never omitted. */
function provenance(draft: Draft): string {
  const parts: string[] = [];
  parts.push(draft.company ? `Company ${draft.company.from}` : "Company not listed");
  parts.push(draft.title ? `Title ${draft.title.from}` : "Title not listed");
  return `${parts.join(". ")}.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The four fact segments the composition draws, in its order.
 *
 * Every one of them reads `Not listed` on a manually added posting, because
 * every one of them is genuinely unknown until a scan reads the page — and
 * `04-design-parity-standard.md` requires an absent fact to say so rather than
 * to vanish. The visible text is the composition's; the label is for a screen
 * reader, which would otherwise hear "Not listed" four times with nothing to
 * attach any of them to.
 */
const FACTS = ["Pay", "Experience", "Work model", "Posted"] as const;

function FactLine() {
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 text-xs tabular-nums text-text-2">
      {FACTS.map((label) => (
        <span key={label} className="text-muted">
          <span className="sr-only">{label}: </span>
          Not listed
        </span>
      ))}
    </div>
  );
}

export default function QuickAdd() {
  const [pasted, setPasted] = React.useState("");
  const [drafts, setDrafts] = React.useState<Draft[] | null>(null);
  const [reading, setReading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [online, setOnline] = React.useState(true);
  // Bumped on every resolve. A slow answer for an older paste is dropped
  // rather than painted over a newer one.
  const generation = React.useRef(0);

  React.useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  React.useEffect(() => {
    if (done) return;
    const text = pasted.trim();
    if (text === "") {
      setDrafts(null);
      setReading(false);
      return;
    }
    setReading(true);
    const mine = ++generation.current;
    const timer = setTimeout(async () => {
      const result = await resolveLinksAction(pasted);
      if (mine !== generation.current) return;
      setReading(false);
      if (!result.ok) {
        setDrafts(null);
        toast.error(
          result.kind === "auth"
            ? "Your session expired. Sign in again and your paste is still here."
            : result.message,
        );
        return;
      }
      setDrafts(result.links.map(draftFrom));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pasted, done]);

  const addable = (drafts ?? []).filter((d) => d.outcome === "pending" || d.outcome === "failed");
  const canSave = addable.length > 0 && !saving && !reading && online;

  function edit(index: number, patch: Partial<Draft>) {
    setDrafts((current) =>
      current == null
        ? current
        : current.map((d, i) => (i === index ? applyDraftEdit(d, patch) : d)),
    );
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    let failures = 0;
    const results = await Promise.all(
      (drafts ?? []).map(async (draft) => {
        if (draft.outcome === "duplicate" || draft.outcome === "added") return draft;
        const result = await addJobAction({
          url: draft.url,
          company: draft.company_,
          title: draft.title_,
          idempotencyKey: draft.idem,
        });
        if (!result.ok) {
          failures += 1;
          if (result.kind === "auth") {
            toast.error("Your session expired. Sign in again; nothing was added.");
          } else {
            toast.error(result.message);
          }
          return { ...draft, outcome: "failed" as const };
        }
        return { ...draft, outcome: result.outcome };
      }),
    );
    setDrafts(results);
    setSaving(false);
    if (failures === 0) setDone(true);
  }

  function reset() {
    setPasted("");
    setDrafts(null);
    setDone(false);
    generation.current += 1;
  }

  const addedCount = (drafts ?? []).filter((d) => d.outcome === "added").length;

  return (
    <div className="mt-4 max-w-[640px]">
      <label className="flex flex-col gap-1" htmlFor="quickadd-links">
        <span className="text-sm font-medium text-text">Posting links</span>
        <textarea
          id="quickadd-links"
          name="links"
          rows={3}
          value={pasted}
          disabled={done}
          onChange={(e) => setPasted(e.target.value)}
          aria-describedby="quickadd-help"
          className="w-full resize-y rounded-md border border-border-strong bg-surface px-2 py-1.5
                     text-sm text-text outline-none focus-visible:border-ring
                     focus-visible:ring-1 focus-visible:ring-ring disabled:text-muted"
        />
        <span className="text-xs text-muted" id="quickadd-help">
          One link or several. New lines, commas, and semicolons all separate.
        </span>
      </label>

      {/* The live region is what makes the resolve step exist for a screen
          reader: without it, a preview appears silently and the only way to
          learn about it is to go looking. */}
      <div aria-live="polite" className="mt-4">
        {reading ? (
          <div>
            <div className="flex gap-3 rounded-xl border border-border p-4">
              <span className="size-5 rounded bg-raised" />
              <div className="flex flex-1 flex-col gap-2">
                <span className="h-3 w-[220px] max-w-full rounded bg-raised" />
                <span className="h-3 w-[280px] max-w-full rounded bg-raised" />
              </div>
            </div>
            <p className="mt-2 text-xs text-muted">Reading the posting</p>
          </div>
        ) : null}

        {!reading && drafts != null && drafts.length > 0 ? (
          <>
            {drafts.length > 1 ? (
              <p className="mb-2 text-xs tabular-nums text-muted">{drafts.length} links found</p>
            ) : null}
            <ul
              className="divide-y divide-border overflow-hidden rounded-xl border border-border"
              data-testid="quickadd-previews"
            >
              {drafts.map((draft, index) => (
                <li className="p-4" key={`${draft.entered}-${index}`}>
                  <div className="flex gap-3">
                    <span className="mt-0.5 inline-flex shrink-0">
                      <LogoAvatar name={draft.company_ || hostOf(draft.url)} size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      {draft.outcome === "duplicate" && draft.duplicate ? (
                        <>
                          <div className="text-sm">
                            <span className="font-medium">{draft.duplicate.company || "Not listed"}</span>{" "}
                            <span>{draft.duplicate.title || "Not listed"}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            Already tracked.{" "}
                            <Link
                              className="underline underline-offset-2"
                              href={`/jobs?q=${encodeURIComponent(draft.duplicate.title || draft.duplicate.company)}`}
                            >
                              Open it in Jobs
                            </Link>
                          </p>
                        </>
                      ) : (
                        <>
                          {draft.unreadable ? (
                            <p className="text-sm text-text">
                              {"Couldn't read this posting. The link is saved; details fill in on the next scan."}
                            </p>
                          ) : null}
                          <p className="mt-1 break-all text-xs font-medium text-text">
                            {draft.url || draft.entered}
                          </p>
                          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                            <label className="flex flex-1 flex-col gap-1">
                              <span className="text-xs text-muted">Company</span>
                              <input
                                className="w-full rounded-md border border-border-strong bg-surface px-2 py-1
                                           text-sm text-text outline-none focus-visible:border-ring
                                           focus-visible:ring-1 focus-visible:ring-ring"
                                disabled={done}
                                maxLength={200}
                                onChange={(e) => edit(index, { company_: e.target.value })}
                                value={draft.company_}
                              />
                            </label>
                            <label className="flex flex-1 flex-col gap-1">
                              <span className="text-xs text-muted">Title</span>
                              <input
                                className="w-full rounded-md border border-border-strong bg-surface px-2 py-1
                                           text-sm text-text outline-none focus-visible:border-ring
                                           focus-visible:ring-1 focus-visible:ring-ring"
                                disabled={done}
                                maxLength={200}
                                onChange={(e) => edit(index, { title_: e.target.value })}
                                value={draft.title_}
                              />
                            </label>
                          </div>
                          <p className="mt-2 text-xs text-muted">{provenance(draft)}</p>
                          <FactLine />
                          {draft.outcome === "added" ? (
                            <p className="mt-2 text-xs text-muted">Saved to Jobs. Checking details.</p>
                          ) : null}
                          {draft.outcome === "failed" ? (
                            <p className="mt-2 text-xs text-text">
                              This one was not added. Try again.
                            </p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {!reading && drafts != null && drafts.length === 0 ? (
          <p className="text-sm text-muted">Nothing to add yet. Paste a link above.</p>
        ) : null}
      </div>

      {!online ? (
        <p className="mt-4 text-xs text-text" id="quickadd-offline">
          Offline. Adding a job needs a connection, and nothing is held for later.
        </p>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        {done ? (
          <>
            <Link
              className="self-center text-sm underline underline-offset-2"
              href="/queue"
            >
              Go to Today
            </Link>
            <Button onClick={reset} variant="primary">
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={reset}>Cancel</Button>
            <Button
              aria-describedby={online ? undefined : "quickadd-offline"}
              disabled={!canSave}
              onClick={save}
              variant="primary"
            >
              {addable.length > 1 ? `Add ${addable.length} to Today` : "Add to Today"}
            </Button>
          </>
        )}
      </div>

      {done && addedCount > 0 ? (
        <p className="mt-2 text-right text-xs tabular-nums text-muted">
          {addedCount === 1 ? "1 job added." : `${addedCount} jobs added.`}
        </p>
      ) : null}
    </div>
  );
}
