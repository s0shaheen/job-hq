"use client";

import { BadgeCheck, CircleHelp, Fingerprint, HelpCircle } from "lucide-react";
import { Popover } from "radix-ui";
import * as React from "react";
import {
  confidenceLabel,
  explainResolution,
  refreshLabel,
  sourceQuality,
  sourceLabel,
  HOW_IT_WAS_FOUND,
  NOT_LISTED,
  type CompanyView,
  type ResolutionConfidence,
} from "@/lib/data/view-models";
import { cn } from "@/lib/utils";

/**
 * The provenance column — `jobs/why-popover.tsx` re-skinned, per the UX teardown's
 * reuse map ("Clay's waterfall attribution ≈ free: `WhyChip` + `WhyPopoverContent`
 * already render a chip-in-column + deep-linking popover explaining a row's
 * cause").
 *
 * What changed in the re-skin is the CLAIM the chip makes, and it is the reason
 * this component exists at all rather than the reliability rank being a plain
 * badge:
 *
 *   the chip states HOW WELL THE SOURCE IS KNOWN, in one word
 *   the popover states the EVIDENCE: which route found it, against which board
 *
 * docs/plans/COMPANY-DISCOVERY-RESEARCH.md's critical UX caveat is that a meter or
 * a column built on `reliability_tier` alone "would render T1's soft estimate as
 * if measured". Two rows can share a rank while one had a Greenhouse API answer
 * and the other is an unchecked Common Crawl slug from a corpus the same research
 * found "contains dead boards". Those are not the same fact, and a person
 * deciding whether to trust a coverage number needs to be able to tell them apart
 * at a glance — hence the word on the chip, not only inside the popover.
 *
 * The words themselves come from `lib/data/view-models.ts` (the display
 * dictionary), never from the engine's own vocabulary. Renaming the component to
 * SourceChip belongs to the Coverage surface build; the labels did not wait.
 *
 * The chip is a button rather than text for why-popover's reason: the cell already
 * states the conclusion, and the click adds the actionable half.
 */

/** Colour + icon per confidence. Colour NEVER carries the meaning alone — the
 *  word is always on the chip (badge.tsx's rule, and the same for colour-blind
 *  readers as for anyone skimming a dense grid where a lone hue is noise). */
const STYLE: Record<
  ResolutionConfidence,
  { chip: string; icon: typeof BadgeCheck; dot: string }
> = {
  verified: {
    chip: "border-ok/40 bg-ok-subtle text-ok",
    icon: BadgeCheck,
    dot: "bg-ok",
  },
  inferred: {
    chip: "border-info/40 bg-info-subtle text-info",
    icon: Fingerprint,
    dot: "bg-info",
  },
  asserted: {
    chip: "border-warn/40 bg-warn-subtle text-warn",
    icon: CircleHelp,
    dot: "bg-warn",
  },
  unresolved: {
    chip: "border-border bg-raised text-muted",
    icon: HelpCircle,
    dot: "bg-muted",
  },
};

/**
 * The one word on the chip.
 *
 * It used to be `tierLabel(tier) · confidenceLabel(confidence)` — "Tier 1 ·
 * day-of · verified" — which broke three rules at once: the banned engine word
 * "tier", the interpunct used as glue, and the engine's own confidence
 * vocabulary. All three now come from the display dictionary, which is where the
 * product's words are chosen. The latency the tier used to carry is not lost: it
 * is a plain sentence in the popover, where there is room for it.
 */
export function provenanceText(company: CompanyView): string {
  return confidenceLabel(sourceQuality(company));
}

/** The chip in the Resolution column. */
export function ProvenanceChip({
  company,
  onClick,
}: {
  company: CompanyView;
  onClick: () => void;
}) {
  const confidence = sourceQuality(company);
  const style = STYLE[confidence];
  const Icon = style.icon;
  const text = provenanceText(company);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${text}. Click for how it was found`}
      data-testid="provenance-chip"
      data-confidence={confidence}
      className={cn(
        "inline-flex h-[22px] min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-left text-xs",
        "hover:border-border-strong focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
        style.chip,
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  );
}

/** The popover body — rendered inside the grid's controlled Popover.Root. */
export function ProvenancePopoverContent({ company }: { company: CompanyView }) {
  const confidence = sourceQuality(company);
  const style = STYLE[confidence];
  const name = company.name.trim() || company.slug || "this company";
  return (
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        data-testid="provenance-popover"
        className="z-40 w-80 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-surface p-3 shadow-xl outline-none"
      >
        <p className="flex items-center gap-1.5 text-xs font-semibold text-text">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", style.dot)} />
          <span className="min-w-0 break-words">{provenanceText(company)}</span>
        </p>
        {/* The evidence, in a sentence. Every branch of explainResolution names
            what was OBSERVED rather than the conclusion drawn from it. */}
        <p className="mt-2 text-xs text-text-2">{explainResolution(company)}</p>

        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-border pt-2 text-2xs">
          <dt className="text-muted">Company</dt>
          <dd className="min-w-0 break-words text-text-2">{name}</dd>
          <dt className="text-muted">Job board</dt>
          <dd className="min-w-0 break-words text-text-2">
            {company.ats && company.slug ? `${company.ats}/${company.slug}` : NOT_LISTED}
          </dd>
          <dt className="text-muted">Source</dt>
          <dd className="min-w-0 break-words text-text-2">{sourceLabel(company.source)}</dd>
          {/* The latency the chip no longer states. A sentence rather than a
              rank: "Tier 1" reads as a grade, and what a person needs from it is
              when the jobs turn up. */}
          <dt className="text-muted">{HOW_IT_WAS_FOUND}</dt>
          <dd className="min-w-0 break-words text-text-2">{refreshLabel(company.tier)}</dd>
        </dl>

        {confidence === "asserted" || confidence === "inferred" ? (
          <p className="mt-2 border-t border-border pt-2 text-2xs text-muted">
            Jobs arriving from this board is what would make this Confirmed. Until then it
            is what this app expects, not what it has seen.
          </p>
        ) : null}
      </Popover.Content>
    </Popover.Portal>
  );
}
