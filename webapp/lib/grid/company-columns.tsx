/**
 * Column model for the /companies universe grid — the same shape as
 * lib/grid/columns.tsx, and for the same reasons: display-only ColumnDefs (no
 * accessorFns), sorting done in a pure module before react-table sees the array,
 * fixed row height so virtualization stays exact, and every cell truncating with
 * the full string on `title=` so truncation hides pixels and never data.
 *
 * The one column that is not a straight port is **Source quality** — the column
 * the UX teardown identifies as the piece the grid already ships. It is
 * `why-popover.tsx` re-skinned: a chip in the cell that states how well the
 * source is known, and a click that explains which route found it. The
 * reliability rank the engine stores is deliberately NOT the chip: a rank alone
 * is the research pass's warned-about failure, a soft estimate reading as a
 * measurement. Every word here comes from the display dictionary in
 * `lib/data/view-models.ts`.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { LogoAvatar } from "@/components/ds";
import type { CompanyView } from "@/lib/data/view-models";
import { NOT_LISTED, sourceLabel } from "@/lib/data/view-models";
import { cn } from "@/lib/utils";

/** Fixed row height — the constant that makes virtualization exact (columns.tsx). */
export const COMPANY_ROW_PX = 32;
export const COMPANY_HEADER_PX = 32;

/** How absence reads, matching the /jobs grid's convention exactly: one word
 *  for an unstated value, everywhere in the product. */
export const ABSENT = NOT_LISTED;

/**
 * A row with no name.
 *
 * Common Crawl mines BOARDS, not companies — `discover_universe.py` writes ""
 * for the name and calls the slug the identity. A blank cell in the leftmost,
 * sticky column reads as a broken row; naming it after the board it actually is
 * tells the truth and gives the human something to click.
 */
export function companyNameText(c: CompanyView): string {
  const name = c.name.trim();
  if (name) return name;
  if (c.slug) return `${c.slug} (board only)`;
  return ABSENT;
}

export function boardText(c: CompanyView): string {
  if (!c.ats && !c.slug) return ABSENT;
  if (!c.slug) return c.ats;
  return `${c.ats}/${c.slug}`;
}

export function sourceText(c: CompanyView): string {
  return sourceLabel(c.source);
}

/**
 * Whether this company is in the scans, in words. Never a bare checkbox: "on"
 * for what?
 *
 * The engine's word for the run is "sweep"; the product's is "scan", and the
 * three states say which list a company is on rather than naming a flag.
 */
export function sweepText(c: CompanyView): string {
  if (c.reviewState !== "approved") return ABSENT;
  if (!c.enabled) return "Paused";
  return c.priority ? "Watching" : "In scans";
}

/** The badge tone each word carries. Shared with the interactive cell. */
export function sweepTone(text: string): "ok" | "info" | "warn" {
  return text === "Watching" ? "ok" : text === "In scans" ? "info" : "warn";
}

/**
 * The review states, as words rather than as the stored tokens. `proposed` is
 * accurate in the table and reads as jargon in a cell.
 */
const REVIEW_LABELS: Record<CompanyView["reviewState"], string> = {
  proposed: "Waiting for you",
  approved: "Approved",
  dismissed: "Passed",
};

/** Truncating text cell — columns.tsx's `Text`, unchanged. */
function Text({ value }: { value: string }) {
  return (
    <span
      className={cn("truncate", value === ABSENT && "text-muted")}
      title={value === ABSENT ? undefined : value}
    >
      {value}
    </span>
  );
}

export const COMPANY_GRID_COLUMNS: ColumnDef<CompanyView>[] = [
  {
    id: "name",
    header: "Company",
    size: 240,
    meta: { sticky: true, grow: true },
    cell: ({ row }) => {
      const text = companyNameText(row.original);
      return (
        // The 16px logo, always beside the name and never alone (01 section 7,
        // and `Coverage.dc.html` line 35). `company.domain` is 0021's column, so
        // a row that has one climbs the ladder and a row that does not is on the
        // monogram already — which is production's common case. The wrapper is
        // `aria-hidden`, so the column announces the company name once instead
        // of "R A Ramp".
        //
        // This is the surface with the most logos in the app, which makes it the
        // one where the ladder's remaining defect costs the most: a row rendered
        // on the SERVER fires its `<img>` error event before hydration, so
        // `onError` never runs and that row parks on the broken-image glyph
        // instead of falling to the monogram. The fix is on feat/redesign-today
        // and is deliberately not duplicated here.
        <span className="flex min-w-0 items-center gap-2">
          <LogoAvatar name={text} domain={row.original.domain} size={16} />
          <span
            // The name has its own element because the monogram beside it is
            // real characters: without this the cell's text reads "RA Ramp".
            data-testid="company-name"
            className={cn("truncate font-medium", !row.original.name.trim() && "text-text-2")}
            title={text}
          >
            {text}
          </span>
        </span>
      );
    },
  },
  {
    // "Included in scans", not "Watching". The design states the toggle's scope
    // ONCE, in the column header, so the cell can be a switch rather than a word
    // (`Coverage.dc.html` lines 28 and 36).
    //
    // It sits second, immediately right of the company, because the template
    // puts it there: the decision a person makes on this row is what the row is
    // for, and reading three columns of evidence before reaching the control is
    // the wrong order for the job.
    //
    // The cell is rendered by the surface when it can WRITE it (the grid owns no
    // store — same arrangement as the Source quality column); this static
    // version is the fallback and the thing a read-only consumer gets.
    id: "sweep",
    header: "Included in scans",
    size: 150,
    cell: ({ row }) => {
      const t = sweepText(row.original);
      if (t === ABSENT) return <Text value={t} />;
      return (
        <Badge tone={sweepTone(t)} className="whitespace-nowrap">
          {t}
        </Badge>
      );
    },
  },
  {
    // The source-quality column. Its cell is rendered by the grid itself (it
    // needs the popover's open state), so the ColumnDef only reserves the width
    // and names the header — the same arrangement the /jobs "why" column uses.
    id: "resolution",
    header: "Source quality",
    size: 180,
    cell: () => null,
  },
  {
    id: "board",
    header: "Job board",
    size: 260,
    cell: ({ row }) => <Text value={boardText(row.original)} />,
  },
  {
    id: "source",
    header: "Source",
    size: 130,
    cell: ({ row }) => <Text value={sourceText(row.original)} />,
  },
  {
    id: "review",
    header: "Review",
    size: 110,
    cell: ({ row }) => {
      const s = row.original.reviewState;
      // Proposed is the majority of the review set — its whole membership — so it
      // renders as quiet text. Colour means state, and a badge on every row is
      // decoration (columns.tsx's Decision column, same argument).
      if (s === "proposed")
        return <span className="truncate text-muted">{REVIEW_LABELS[s]}</span>;
      return (
        <Badge tone={s === "approved" ? "accent" : "neutral"} className="whitespace-nowrap">
          {REVIEW_LABELS[s]}
        </Badge>
      );
    },
  },
];
