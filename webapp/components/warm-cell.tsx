"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ConnectionView } from "@/lib/data/view-models";
import { setLinkedinCompanyIdAction } from "@/lib/referral/actions";
import { connectionUrl, extractLinkedinId, warmLinks } from "@/lib/referral/linkedin";
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
  // Nothing to offer and nothing to fix from here. An em dash, the grid's own
  // convention for "nothing stated" — never a button that cannot do anything.
  return { text: "—", tone: "muted" };
}

export function WarmCell(props: WarmCellProps) {
  const [open, setOpen] = React.useState(false);
  const firstDegree = props.connections.length;
  const hasId = props.companyId !== "";
  const canPaste = props.universeId !== null;
  const summary = summaryLabel({ firstDegree, hasId, canPaste });

  if (summary.text === "—") {
    return (
      <span className="truncate text-muted" data-testid="warm-none">
        —
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
          aria-label={`Warm paths at ${props.company}`}
          className={cn(
            "inline-flex h-[22px] min-w-0 max-w-full items-center rounded-md border px-1.5 text-left text-xs",
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
                      <span className="ml-1 text-muted" title={c.title}>
                        · {c.title}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {overflow > 0 ? (
                <p className="mt-1 text-xs text-muted">
                  and {overflow} more — the rest are on{" "}
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
          These open LinkedIn&rsquo;s own search in your browser, signed in as you. Nothing is
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
  onDone: () => void;
}) {
  const [value, setValue] = React.useState("");
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
    const parsed = extractLinkedinId(value);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setBusy(true);
    idem.current ??= crypto.randomUUID();
    const result = await setLinkedinCompanyIdAction({
      companyId: props.universeId!,
      linkedinId: parsed.id,
      idempotencyKey: idem.current,
      expectedUpdatedAt: props.companyUpdatedAt,
    });
    setBusy(false);
    if (result.ok) {
      idem.current = null;
      toast.success(`Saved the LinkedIn id for ${props.company}`);
      props.onDone();
      return;
    }
    if (result.kind === "conflict") {
      setError("Somebody set this on another device. Reload to see their value.");
      return;
    }
    setError(result.kind === "auth" ? "Your session expired — sign in again." : result.message);
  }

  return (
    <form onSubmit={submit} data-testid="warm-paste-form">
      <label htmlFor="warm-linkedin-id" className="text-xs text-text-2">
        No LinkedIn id for {props.company} yet
      </label>
      <p className="mt-1 text-xs text-muted">
        Open the company on LinkedIn, click <em>See all employees</em>, and paste that page&rsquo;s
        address here. Once per company.
      </p>
      <div className="mt-2 flex gap-1">
        <input
          id="warm-linkedin-id"
          name="linkedinId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="…f_C=1035 or just 1035"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-raised px-2 py-1 text-xs
                     text-text placeholder:text-muted focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || value.trim() === ""}>
          {busy ? "Saving…" : "Save"}
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
