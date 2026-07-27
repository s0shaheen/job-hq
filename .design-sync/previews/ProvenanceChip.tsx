import { Popover, ProvenanceChip, ProvenancePopoverContent } from "hq-webapp";

/**
 * Rows are the app's own company fixtures (lib/data/company-fixtures.ts).
 *
 * The point of the chip is that two rows can both read "Tier 1 · day-of" while
 * one had a Greenhouse API answer and the other is an unprobed Common Crawl
 * slug — so the chip states the tier AND how it was established, and the click
 * adds the evidence. The four confidences below are exactly that distinction:
 *
 *   verified    a board API answered            (discover-*, workday-redirect)
 *   inferred    fingerprint or aggregator       (no board call behind it)
 *   unverified  a slug taken on trust           (ingested-slug, never re-probed)
 *   unresolved  no board found                  (tier null)
 *
 * `Popover` is imported from the DS, not from `radix-ui` — the portal inside
 * `ProvenancePopoverContent` reads the bundled radix's context.
 */

type Company = React.ComponentProps<typeof ProvenanceChip>["company"];

function co(seed: Partial<Company> & Pick<Company, "name">): Company {
  return {
    key: seed.slug || seed.name,
    id: 1,
    ats: "",
    slug: "",
    source: "manual",
    tier: null,
    resolutionMethod: "",
    reviewState: "approved",
    enabled: true,
    priority: false,
    seeded: false,
    linkedinCompanyId: "",
    updatedAt: "2026-07-21T15:00:00.000Z",
    companyUpdatedAt: "2026-07-21T15:00:00.000Z",
    ...seed,
  };
}

const VERIFIED = co({
  name: "Ramp", ats: "ashby", slug: "ramp", source: "seed",
  tier: 1, resolutionMethod: "discover-ashby",
});
const INFERRED = co({
  name: "Aon", ats: "icims", slug: "aon", source: "formadv",
  tier: 2, resolutionMethod: "aggregator",
});
const ASSERTED = co({
  name: "Fifth Third Bank", ats: "greenhouse", slug: "fifththird", source: "commoncrawl",
  tier: 1, resolutionMethod: "ingested-slug",
});
const UNRESOLVED = co({ name: "Grainger", source: "paste" });

/**
 * The chip is a plain function component, so it does NOT forward refs — a
 * `Popover.Trigger asChild` around it silently gets no anchor element, Floating
 * UI falls back to a 0×0 rect at the origin, and the panel lands off the top of
 * the card (measured: rect.y = -386). Anchoring a `<span>` instead is what makes
 * the open cards below position correctly.
 */
function Anchored({ company }: { company: Company }) {
  return (
    <Popover.Root defaultOpen>
      <Popover.Anchor asChild>
        <span className="inline-flex max-w-full">
          <ProvenanceChip company={company} onClick={() => {}} />
        </span>
      </Popover.Anchor>
      <ProvenancePopoverContent company={company} />
    </Popover.Root>
  );
}

/**
 * All four, in a Resolution column. The word beside the tier is the whole
 * feature — two Tier 1 rows that are not the same fact must not look alike.
 */
export function Confidences() {
  return (
    // Width capped with an INLINE style, not `max-w-sm`: `build-css.mjs` only
    // scans the webapp for class names, so a utility that appears solely in a
    // preview never gets compiled and silently does nothing (this container
    // rendered 1200px wide until the cap moved inline).
    <div
      style={{ maxWidth: 420 }}
      className="divide-y divide-border rounded-lg border border-border"
    >
      {[VERIFIED, ASSERTED, INFERRED, UNRESOLVED].map((c) => (
        <div key={c.key} className="flex items-center justify-between gap-4 px-3 py-2">
          <span className="min-w-0 truncate text-sm text-text">{c.name}</span>
          <ProvenanceChip company={c} onClick={() => {}} />
        </div>
      ))}
    </div>
  );
}

/**
 * The evidence, open. Every line names what was OBSERVED rather than the
 * conclusion — the board it was confirmed against, where it was found, and the
 * raw method token verbatim so an operator can debug a mis-bucketed row.
 */
export function EvidenceForAVerifiedRow() {
  return (
    <div style={{ minHeight: 250 }}>
      <Anchored company={VERIFIED} />
    </div>
  );
}

/**
 * The same panel for a slug nobody has probed. It gains the closing caveat —
 * "a sweep pulling from this board is what would turn this into verified" —
 * which is the sentence that keeps a soft tier from reading as a measurement.
 */
export function EvidenceForAnUnprobedSlug() {
  return (
    <div style={{ minHeight: 290 }}>
      <Anchored company={ASSERTED} />
    </div>
  );
}
