import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { decisionFacts, NOT_LISTED, type JobView } from "@/lib/data/view-models";
import { safeHref } from "@/lib/url/safe-href";
import { cn } from "@/lib/utils";

/**
 * One posting, presented for a decision.
 *
 * The layout answers a specific, measured failure: half of the roles the owner
 * shortlisted were later abandoned because they were "off on YoE, location or
 * salary and I just didn't read it thoroughly." So compensation, minimum
 * years, work model and location are a fixed four-tile bar that is ALWAYS
 * rendered, never behind a click, and never omitted when unknown — an absent
 * tile reads as a narrower posting, whereas "Not listed" reads as a question
 * to answer before spending effort.
 */
export function TriageCard({ job, mismatch }: { job: JobView; mismatch?: string | null }) {
  const facts = decisionFacts(job);
  const tiles = [
    { label: "Comp", value: facts.comp },
    { label: "Min YoE", value: facts.minYoe },
    { label: "Work model", value: facts.workModel },
    { label: "Location", value: facts.location },
  ];

  return (
    <article className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      {/* min-w-0 + break-words on the headings: company and title arrive from
          ATS boards unsanitised, and an unbroken token (a product name, a
          pasted slug) otherwise paints past the card edge, where the page's
          overflow-x:hidden clips it out of reach. The flex-item heading also
          needs min-w-0, or its min-content width is the whole token. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="min-w-0 break-words text-sm font-semibold">{job.company}</h2>
        {job.industry ? <Badge tone="info">{job.industry}</Badge> : null}
        {/* `job.url` is stored posting data; it becomes a live href only through
            the shared guard. A refused URL still shows the "Posted"/date text, as
            a span, so the card does not silently lose the line. */}
        {safeHref(job.url) ? (
          <a
            href={safeHref(job.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
          >
            {job.posted ? `Posted ${job.posted}` : "Open posting"}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted">
            {job.posted ? `Posted ${job.posted}` : "Open posting"}
          </span>
        )}
      </div>

      <h3 className="mt-1 break-words text-xl font-semibold tracking-tight text-balance">
        {job.title}
      </h3>

      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="bg-surface px-3 py-2">
            <dd
              className={cn(
                "tabular text-sm font-semibold",
                t.value === NOT_LISTED && "font-normal text-muted",
              )}
            >
              {t.value}
            </dd>
            <dt className="mt-0.5 text-2xs font-medium text-muted">
              {t.label}
            </dt>
          </div>
        ))}
      </dl>

      {mismatch ? (
        <p className="mt-3 rounded-md bg-warn-subtle px-3 py-2 text-xs text-warn">{mismatch}</p>
      ) : null}

      {job.roleFocus ? (
        <div className="mt-4">
          <p className="text-2xs font-semibold text-muted">About the role</p>
          <p className="mt-1 text-sm text-text-2">{job.roleFocus}</p>
        </div>
      ) : null}

      {job.skills.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {job.skills.map((s) => (
            <li key={s} className="rounded-sm bg-raised px-1.5 py-0.5 text-xs text-muted">
              {s}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
