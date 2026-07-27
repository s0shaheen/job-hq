"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import * as React from "react";
import { explainReason, reasonSetting, type JobView } from "@/lib/data/view-models";

/**
 * The why-filtered escape hatch (spec C, plan §6): the sentence for a row's
 * disposition reason, plus the PROFILE SETTING that caused it, deep-linked to
 * its /settings anchor. The anchor ids are `reasonSetting()`'s outputs and the
 * settings page ships them as real sections, so the link can never 404 —
 * routing.spec.ts derives that guarantee from the same function.
 */

/**
 * How each setting is named to a person. Mirrors SETTING_LABELS in
 * lib/data/view-models.ts (not exported there) and the section headings in
 * app/(app)/settings/page.tsx — three spellings of one vocabulary, kept in
 * step by the e2e asserting the rendered copy against the settings page.
 */
const SETTING_LABELS: Record<string, string> = {
  countries: "countries",
  metros: "cities",
  yoeMax: "experience limit",
  seniorityExclude: "levels ruled out",
  compMin: "pay floor",
  workModelExclude: "ways of working",
};

/**
 * The chip in the Why column. A button, not text: the column already states
 * the sentence, and the click adds the actionable half — which setting, and
 * where to change it.
 */
export function WhyChip({ job, onClick }: { job: JobView; onClick: () => void }) {
  const text = explainReason(job.dispositionReason);
  return (
    <button
      type="button"
      onClick={onClick}
      title={text}
      className="inline-flex h-[22px] min-w-0 max-w-full items-center rounded-md border border-border
                 bg-raised px-1.5 text-left text-xs text-text-2 hover:border-border-strong hover:bg-surface
                 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
    >
      <span className="truncate">{text}</span>
    </button>
  );
}

/** The popover body — rendered inside the grid's controlled Popover.Root. */
export function WhyPopoverContent({ job }: { job: JobView }) {
  const setting = reasonSetting(job.dispositionReason);
  const label = setting ? (SETTING_LABELS[setting] ?? setting) : null;
  return (
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        data-testid="why-popover"
        className="z-40 w-72 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-surface p-3 shadow-xl outline-none"
      >
        <p className="text-xs text-text">{explainReason(job.dispositionReason)}</p>
        {setting && label ? (
          <Link
            href={`/settings#${setting}`}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            Change your {label}
            <ArrowRight aria-hidden="true" className="size-3" />
          </Link>
        ) : null}
      </Popover.Content>
    </Popover.Portal>
  );
}
