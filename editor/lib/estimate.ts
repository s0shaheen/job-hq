// One-page heuristic — an honest client-side ESTIMATE, not the gate. CI's
// render step (PNG count must be 1) is the real enforcement; this chip only
// warns before publish. Counts rendered text lines at ~95 chars/line (harvard
// theme, 10pt body, 0.5in margins) plus per-element overhead.
//
// BUDGET calibrated 2026-07-13 against resume/base.yaml, which renders exactly
// one page and is known-snug (recent history is all density trims). The
// estimator scored it 77.6 (it overcounts absolute lines — real render fits
// ~105 chars/line — but *deltas* track well), so: fits <= 78, tight 78-81,
// above that likely 2 pages. Recalibrate BUDGET_LINES if design.yaml font
// sizes or margins change materially: score the then-current base.yaml, set
// budget just above it.

import type { CvModel, EntryModel } from "./model";

export const CHARS_PER_LINE = 95;
const HEADER_LINES = 4; // name + contact line + gaps
const SECTION_TITLE_LINES = 2; // title + rule + spacing
const ENTRY_HEADER_LINES = 2; // company/location + position/dates
const BULLET_GAP = 0.15; // inter-bullet spacing amortized in lines
const ENTRY_GAP = 0.35; // space_between_regular_entries
export const BUDGET_LINES = 78;
const TIGHT_MARGIN = 3;

export type Fit = {
  verdict: "fits" | "tight" | "two-pages";
  label: string;
  lines: number; // rounded estimate
  budget: number;
};

function textLines(s: string): number {
  return Math.max(1, Math.ceil(s.trim().length / CHARS_PER_LINE));
}

function entryLines(e: EntryModel): number {
  if (e.kind === "text") return textLines(e.text) + BULLET_GAP;
  let lines = 0;
  if (e.bullets) {
    lines += ENTRY_HEADER_LINES + ENTRY_GAP;
    for (const b of e.bullets) lines += textLines(b.text) + BULLET_GAP;
  } else {
    const details = e.fields.find((f) => f.key === "details");
    if (details) {
      // text-based row rendered as "Label: details", tight spacing
      const label = e.fields.find((f) => f.key === "label")?.value ?? "";
      lines += textLines(`${label}: ${details.value}`) + 0.1;
    } else {
      // education-style: institution/area line + date, optional summary line
      lines += ENTRY_HEADER_LINES + ENTRY_GAP;
      if (e.fields.some((f) => f.key === "summary" && f.value.trim())) lines += 1;
    }
  }
  return lines;
}

export function estimatePage(model: CvModel | null): Fit | null {
  if (!model) return null;
  let lines = HEADER_LINES;
  for (const sec of model.sections) {
    lines += SECTION_TITLE_LINES;
    for (const e of sec.entries) lines += entryLines(e);
  }
  const rounded = Math.round(lines * 10) / 10;
  const verdict = lines <= BUDGET_LINES ? "fits" : lines <= BUDGET_LINES + TIGHT_MARGIN ? "tight" : "two-pages";
  const label =
    verdict === "fits" ? "fits 1 page" : verdict === "tight" ? "tight — near the limit" : "likely 2 pages";
  return { verdict, label, lines: rounded, budget: BUDGET_LINES };
}
