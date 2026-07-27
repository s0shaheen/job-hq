import * as React from "react";
import { StatusSelect } from "hq-webapp";

/**
 * The pipeline's status control. Rows and statuses are the app's own
 * (lib/status.ts `STATUS_ORDER` + `STATUS_TERMINAL`, and the fixture
 * applications in lib/data/fixtures.ts).
 *
 * The pill IS the trigger, so a pipeline row reads the same whether or not it is
 * editable — a separate chrome-heavy control per row turns a scannable list into
 * a form.
 */

/**
 * Widths are inline, not `max-w-*`: `build-css.mjs` scans the webapp for class
 * names, so a utility used only in a preview is never compiled and does nothing.
 * Without the cap these rows stretched to 1200px on the single card, leaving the
 * company at the far left and its pill a full screen away.
 */
const list: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 320,
  maxWidth: 480,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
};

function Row({ company, title, status, id, disabled }: {
  company: string;
  title: string;
  status: string;
  id: number;
  disabled?: boolean;
}) {
  return (
    <div style={rowStyle}>
      <span className="min-w-0 text-sm">
        <span className="font-medium text-text">{company}</span>{" "}
        <span className="text-muted">· {title}</span>
      </span>
      <StatusSelect applicationId={id} status={status} disabled={disabled} onSelect={() => {}} />
    </div>
  );
}

/** Four rows mid-pipeline — the tone vocabulary as a person meets it. */
export function PipelineRows() {
  return (
    <div style={list}>
      <Row id={41} company="Ramp" title="Product Manager, Core Platform" status="Applied" />
      <Row id={42} company="Stripe" title="Product Manager, Billing" status="Screen" />
      <Row id={43} company="Plaid" title="Product Manager, Payments" status="Offer" />
      <Row id={44} company="Notion" title="Product Manager, Growth" status="Rejected" />
    </div>
  );
}

/** Every stage the bots can advance a row through, in pipeline order. */
export function EveryStage() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxWidth: 460 }}>
      {["Inbox", "Queued", "Applied", "OA", "Screen", "Interview", "Final", "Offer",
        "Rejected", "Withdrawn", "Closed"].map((s, i) => (
        <StatusSelect key={s} applicationId={100 + i} status={s} onSelect={() => {}} />
      ))}
    </div>
  );
}

/**
 * A status somebody typed themselves. The sheet allows one and `statusRank`
 * ranks it highest by construction, so the control offers it back to itself
 * rather than rendering an empty trigger over a row whose status is plainly
 * visible.
 */
export function CustomStatus() {
  return (
    <div style={list}>
      <Row id={51} company="Handshake AI" title="Software Product Lead" status="Take-home sent" />
      <Row id={52} company="Brex" title="Product Manager, Spend" status="Waiting on referral" />
    </div>
  );
}

/** While a write is in flight the pill still states the status; it just refuses. */
export function Disabled() {
  return (
    <div style={list}>
      <Row id={61} company="Mercury" title="Product Manager, Banking" status="Interview" disabled />
    </div>
  );
}

/**
 * The menu open, so the vocabulary is visible without an interaction.
 *
 * Radix opens on a key press on the trigger, so the card presses one on mount —
 * the same path a keyboard user takes. It portals to <body>, which is why this
 * component carries a `cardMode: "single"` override: the popover would otherwise
 * escape its grid cell.
 */
export function Open() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const trigger = ref.current?.querySelector("button");
    if (!trigger) return;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, []);
  return (
    <div ref={ref} style={{ minHeight: 320 }}>
      <StatusSelect applicationId={71} status="Applied" onSelect={() => {}} />
    </div>
  );
}
