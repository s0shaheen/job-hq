"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NOT_LISTED, type ConnectionView } from "@/lib/data/view-models";
import { setLinkedinCompanyIdAction } from "@/lib/referral/actions";
import {
  connectionUrl,
  extractLinkedinId,
  isEngineWrittenId,
  warmLinks,
} from "@/lib/referral/linkedin";
import { MAX_LISTED_CONNECTIONS } from "@/lib/referral/match";
import { cn } from "@/lib/utils";

/**
 * The warm-paths cell — one chip per row on /jobs and /pipeline, expanding to
 * the two things layer 0 can honestly offer.
 *
 * WHAT THIS IS, IN THE COPY AND IN THE CODE
 *
 * Every link here opens LinkedIn's own people search **in the reader's own
 * browser, in their own session**. Nothing is fetched, no session is touched, no
 * message is sent on anybody's behalf, and there is no code path from this
 * component to linkedin.com other than an `<a href>` a person clicks. The
 * footer says so in as many words, because a feature that surfaces "who you
 * know at this company" is one people reasonably assume is scraping — and
 * because the moment it did, LinkedIn's enforcement is suspension-first and the
 * account is the delivery channel for the whole referral play
 * (`docs/plans/REFERRAL-FINDER.md`, the risk ladder).
 *
 * WHAT IT DELIBERATELY DOES NOT SAY
 *
 * There is no outreach tracking yet — no "contacted", no "replied", no drafts.
 * That is step 3 of the build shape and it is not built, so no string in this
 * file implies it. Copy that promises unwired behaviour is the defect matrix row
 * 227 records; the fix is to not write it, not to write it and hide it.
 */

export type WarmCellProps = {
  /** The row's company, verbatim. Matching is by normalized key, not this. */
  company: string;
  /** The posting/application title, for the role-peers search. */
  title: string;
  /** `companies.linkedin_company_id`, or "" when nobody has pasted one. */
  companyId: string;
  /**
   * `companies.linkedin_id_source` (0016) — who put `companyId` there: `"human"`,
   * `"engine"`, or `""` when it is empty.
   *
   * WHY A CELL NEEDS TO KNOW. The searches below render in place of the paste box,
   * so a valid id used to remove the only writer surface in the app: no change, no
   * clear, no settings row anywhere. That was fine while the only writer was the
   * person who pasted it. It stopped being fine when the TheirStack sweep started
   * harvesting ids (0016), because a bot's answer for hundreds of companies is one
   * nobody could disagree with — and clearing the cell is exactly how somebody says
   * "wrong id, and I do not have the right one".
   *
   * So the correction control appears for `"engine"` and only for `"engine"`: the
   * regression's own footprint, nothing wider. A human-pasted id keeps the surface
   * it has always had.
   */
  linkedinIdSource: string;
  /** The user's connections at this company, already matched and ordered. */
  connections: readonly ConnectionView[];
  /**
   * The `companies.id` a paste would write to, or null when this user watches
   * no company by this name.
   *
   * Null is a real state, not an edge: a posting can arrive through the wide net
   * from a company nobody has added, and offering a paste box with nowhere to
   * write is worse than saying so.
   */
  universeId: number | null;
  /** The SHARED company row's version token — the one the paste sends back. */
  companyUpdatedAt: string | null;
  /** Whether the user has imported an export at all. Changes the empty copy. */
  hasAnyConnections: boolean;
};

/** The compact cell label. Kept short — this is a grid column. */
function summaryLabel(props: {
  firstDegree: number;
  hasId: boolean;
  canPaste: boolean;
}): { text: string; tone: "warm" | "plain" | "muted" } {
  if (props.firstDegree > 0) {
    return { text: `${props.firstDegree} 1st-degree`, tone: "warm" };
  }
  if (props.hasId) return { text: "Search", tone: "plain" };
  if (props.canPaste) return { text: "Add ID", tone: "muted" };
  // Nothing to offer and nothing to fix from here. "Not listed", the grid's own
  // word for an absent value. Never a button that cannot do anything.
  return { text: NOT_LISTED, tone: "muted" };
}

export function WarmCell(props: WarmCellProps) {
  const [open, setOpen] = React.useState(false);
  const firstDegree = props.connections.length;
  const hasId = props.companyId !== "";
  const canPaste = props.universeId !== null;
  const summary = summaryLabel({ firstDegree, hasId, canPaste });

  if (summary.text === NOT_LISTED) {
    return (
      <span className="truncate text-muted" data-testid="warm-none">
        {NOT_LISTED}
      </span>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="warm-chip"
          data-warm-first-degree={firstDegree}
          aria-label={
            firstDegree > 0
              ? `You know someone here: ${props.connections.map((connection) => connection.fullName).join(", ")}`
              : `Find a warm intro at ${props.company}`
          }
          className={cn(
            "inline-flex h-[22px] min-w-0 max-w-full items-center rounded-md border px-1.5 text-left text-xs tabular",
            "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
            summary.tone === "warm"
              ? "border-accent-subtle bg-accent-subtle font-medium text-accent hover:border-accent"
              : summary.tone === "plain"
                ? "border-border bg-raised text-text-2 hover:border-border-strong hover:bg-surface"
                : "border-border bg-raised text-muted hover:border-border-strong hover:text-text-2",
          )}
        >
          <span className="truncate">{summary.text}</span>
        </button>
      </Popover.Trigger>
      <WarmPopoverContent {...props} onDone={() => setOpen(false)} />
    </Popover.Root>
  );
}

function WarmPopoverContent(props: WarmCellProps & { onDone: () => void }) {
  const links = warmLinks({ companyId: props.companyId, title: props.title });
  const listed = props.connections.slice(0, MAX_LISTED_CONNECTIONS);
  const overflow = props.connections.length - listed.length;
  // The correction path, opened on demand rather than always rendered: the searches
  // are what somebody came here for, and a form above them would push the whole link
  // list down for every company whether or not the id is in question.
  const [correcting, setCorrecting] = React.useState(false);
  // The rule lives in `linkedin.ts` beside `isLinkedinId`, and is pinned there in both
  // directions: an unrecognised provenance is NOT evidence that a bot wrote the id,
  // and this button's copy asserts that it did.
  const botWrote = isEngineWrittenId(props.linkedinIdSource);

  return (
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        data-testid="warm-popover"
        className="z-40 w-80 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-surface p-3 shadow-xl outline-none"
      >
        <p className="text-xs font-medium text-text">Warm paths at {props.company}</p>

        {/* --- who you already know ------------------------------------- */}
        <div className="mt-2">
          {listed.length > 0 ? (
            <>
              <p className="text-xs text-text-2">
                {props.connections.length} 1st-degree{" "}
                {props.connections.length === 1 ? "connection" : "connections"} here
              </p>
              <ul className="mt-1 space-y-1" data-testid="warm-connections">
                {listed.map((c) => (
                  <li key={c.id} className="min-w-0 text-xs">
                    <a
                      href={connectionUrl({
                        profileUrl: c.profileUrl,
                        fullName: c.fullName,
                        companyId: props.companyId,
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-center gap-1 text-accent hover:underline"
                    >
                      <span className="truncate">{c.fullName}</span>
                      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                    </a>
                    {c.title ? (
                      <span className="text-muted" title={c.title}>
                        , {c.title}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {overflow > 0 ? (
                <p className="mt-1 text-xs text-muted">
                  and {overflow} more. The rest are on{" "}
                  <Link href="/connections" className="text-accent hover:underline">
                    your connections
                  </Link>
                </p>
              ) : null}
            </>
          ) : props.hasAnyConnections ? (
            // Two states with opposite remedies, kept apart: "nobody you know
            // works here" is a fact about this company; "you have not uploaded
            // anything" is a thing to go and do. Collapsing them is how a
            // working feature convinces somebody it is broken (matrix row 15).
            <p className="text-xs text-muted" data-testid="warm-no-connections">
              None of your connections work here.
            </p>
          ) : (
            <p className="text-xs text-muted" data-testid="warm-no-import">
              <Link href="/connections" className="text-accent hover:underline">
                Import your LinkedIn connections
              </Link>{" "}
              to see who you already know here.
            </p>
          )}
        </div>

        {/* --- the searches ---------------------------------------------- */}
        <div className="mt-3 border-t border-border pt-2">
          {links.length > 0 ? (
            <>
              <ul className="space-y-1" data-testid="warm-links">
                {links.map((l) => (
                  <li key={l.id}>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`warm-link-${l.id}`}
                      title={l.detail}
                      className="inline-flex max-w-full items-center gap-1 text-xs text-accent hover:underline"
                    >
                      <span className="truncate">{l.label}</span>
                      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                    </a>
                  </li>
                ))}
              </ul>
              {/* The correction path for an id the SWEEP wrote. Renders nothing at
                  all for a human-pasted id, which is what keeps every existing
                  popover — and the baseline that screenshots one — untouched. */}
              {botWrote && props.universeId !== null ? (
                correcting ? (
                  <div className="mt-2">
                    <PasteIdForm
                      company={props.company}
                      universeId={props.universeId}
                      companyUpdatedAt={props.companyUpdatedAt}
                      current={props.companyId}
                      onDone={props.onDone}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="warm-change-id"
                    onClick={() => setCorrecting(true)}
                    className="mt-2 text-xs text-muted underline decoration-dotted
                               underline-offset-2 hover:text-text-2
                               focus-visible:outline-2 focus-visible:-outline-offset-1
                               focus-visible:outline-ring"
                  >
                    {/* States only what is true and wired: the scan put this number
                        here, and this is where it gets changed. No claim about how it
                        was found, no promise that a better one exists, no mention of
                        clearing. The form says that, once it is open. */}
                    The scan set this ID. Change it
                  </button>
                )
              ) : null}
            </>
          ) : (
            <PasteIdForm
              company={props.company}
              universeId={props.universeId}
              companyUpdatedAt={props.companyUpdatedAt}
              onDone={props.onDone}
            />
          )}
        </div>

        <p className="mt-3 border-t border-border pt-2 text-xs text-muted">
          These open LinkedIn's own search in your browser, signed in as you. Nothing is
          fetched from LinkedIn and nothing is sent on your behalf.
        </p>
      </Popover.Content>
    </Popover.Portal>
  );
}

/**
 * The paste-once-per-company prompt.
 *
 * Lazy backfill is the design (`REFERRAL-FINDER.md`: "IDs backfilled lazily —
 * paste `f_C=` once per company"), so this is the whole provisioning path and it
 * lives where the person notices the gap rather than on a settings page they
 * would have to know to visit.
 */
function PasteIdForm(props: {
  company: string;
  universeId: number | null;
  companyUpdatedAt: string | null;
  /**
   * The id already in the cell, when this form is CORRECTING one rather than
   * providing the first. Absent (the original case) means the cell is empty.
   *
   * Two things change when it is set: the field starts on the current value so a
   * person can see what they are disagreeing with, and an EMPTY submit becomes legal.
   * The empty submit is the point — `app_set_linkedin_company_id` has always accepted
   * `''`, and 0016 turned that into a tombstone the sweep will not overwrite, so
   * "clear it" is the honest answer when the bot is wrong and you have no better
   * number. Without this it was unreachable: the Save button disabled on an empty
   * field and `extractLinkedinId("")` returns an error.
   */
  current?: string;
  onDone: () => void;
}) {
  const correcting = props.current !== undefined;
  const [value, setValue] = React.useState(props.current ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // One key per GESTURE, reused by every retry of it. A fresh uuid per attempt
  // is what made Retry apply twice against an append-only trail (matrix row 136).
  const idem = React.useRef<string | null>(null);

  if (props.universeId === null) {
    return (
      <p className="text-xs text-muted" data-testid="warm-not-in-universe">
        You are not tracking {props.company} yet.{" "}
        <Link href="/companies/add" className="text-accent hover:underline">
          Add it
        </Link>{" "}
        to give it a LinkedIn id.
      </p>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Emptying the field is a gesture, not a parse failure — but only when there is
    // something to empty. On the first-paste form a blank submit is still the error
    // the label asks for.
    const clearing = correcting && value.trim() === "";
    let linkedinId = "";
    if (!clearing) {
      const parsed = extractLinkedinId(value);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      linkedinId = parsed.id;
    }
    setError(null);
    setBusy(true);
    idem.current ??= crypto.randomUUID();
    const result = await setLinkedinCompanyIdAction({
      companyId: props.universeId!,
      linkedinId,
      idempotencyKey: idem.current,
      expectedUpdatedAt: props.companyUpdatedAt,
    });
    setBusy(false);
    if (result.ok) {
      idem.current = null;
      // The success string is unchanged for the save path, deliberately:
      // `referral.spec.ts` asserts it verbatim, and this branch has no business
      // rewording somebody else's passing test.
      toast.success(
        clearing
          ? `Cleared the LinkedIn id for ${props.company}`
          : `Saved the LinkedIn id for ${props.company}`,
      );
      props.onDone();
      return;
    }
    if (result.kind === "conflict") {
      setError("Somebody set this on another device. Reload to see their value.");
      return;
    }
    setError(result.kind === "auth" ? "Your session expired. Sign in again." : result.message);
  }

  return (
    <form onSubmit={submit} data-testid="warm-paste-form">
      <label htmlFor="warm-linkedin-id" className="text-xs text-text-2">
        {correcting
          ? `LinkedIn ID for ${props.company}`
          : `No LinkedIn id for ${props.company} yet`}
      </label>
      <p className="mt-1 text-xs text-muted">
        {correcting ? (
          <>
            Open the company on LinkedIn, click "See all employees", and paste that page's
            address. Or empty the field to remove the ID. The scan will not put it back.
          </>
        ) : (
          <>
            Open the company on LinkedIn, click "See all employees", and paste that page's
            address here. Once per company.
          </>
        )}
      </p>
      <div className="mt-2 flex gap-1">
        <input
          id="warm-linkedin-id"
          name="linkedinId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="f_C=1035 or 1035"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-raised px-2 py-1 text-xs
                     text-text placeholder:text-muted focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        />
        {/* Correcting, the disabled rule inverts: an EMPTY field is the clear
            gesture, and what has nothing to submit is a field still holding the id
            it arrived with. On the first-paste form an empty field is nothing to
            save, exactly as before. */}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={
            busy ||
            (correcting ? value.trim() === (props.current ?? "").trim() : value.trim() === "")
          }
        >
          {busy ? "Saving" : correcting && value.trim() === "" ? "Clear" : "Save"}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert" data-testid="warm-paste-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
