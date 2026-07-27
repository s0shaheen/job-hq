import { Badge } from "hq-webapp";

/**
 * Every label here is one the app actually renders: statuses through
 * `statusTone` (lib/status.ts), sweep state through `sweepTone`
 * (lib/grid/company-columns.tsx), the industry pill on a triage card, and the
 * channel row on /health.
 *
 * Colour never travels alone — each pill carries the word too.
 */

const row: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
};

/** The six tones, each with a label the app really uses at that tone. */
export function Tones() {
  return (
    <div style={row}>
      <Badge>Inbox</Badge>
      <Badge tone="ok">Offer</Badge>
      <Badge tone="warn">paused</Badge>
      <Badge tone="danger">4 rows refused</Badge>
      <Badge tone="info">Applied</Badge>
      <Badge tone="accent">approved</Badge>
    </div>
  );
}

/**
 * The sweep column on /companies. Three words, three tones, and the tone is
 * never the only difference — `sweepTone` maps the word, not the row.
 */
export function SweepState() {
  return (
    <div style={row}>
      <Badge tone="ok">watching</Badge>
      <Badge tone="info">on</Badge>
      <Badge tone="warn">paused</Badge>
      <span className="text-muted">—</span>
    </div>
  );
}

/** As it lands in a row: the company, then the industry the tagger wrote. */
export function InAHeading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-text">Ramp</span>
        <Badge tone="info">Fintech — spend management</Badge>
      </p>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-text">Northern Trust</span>
        <Badge tone="info">Financial services</Badge>
        <Badge tone="warn">stale</Badge>
      </p>
    </div>
  );
}

/**
 * The reason this component carries no `whitespace-nowrap`: in a narrow column
 * a long industry label wraps inside the pill instead of painting past the page
 * edge, where `html { overflow-x: hidden }` would clip it unreachably. A caller
 * that wants one line sets nowrap on the container — the pipeline's cells do.
 */
export function LongLabelWraps() {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ width: 170 }} className="rounded-md border border-dashed border-border p-2">
        <Badge tone="info">Financial services — wealth and asset management</Badge>
      </div>
      <div style={{ width: 170 }} className="rounded-md border border-dashed border-border p-2">
        <Badge tone="accent">Product Operations Manager</Badge>
      </div>
    </div>
  );
}
