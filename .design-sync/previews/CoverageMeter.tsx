import * as React from "react";
import { CoverageMeter } from "hq-webapp";

/**
 * Rows from the app's own company fixtures. The meter filters to the APPROVED
 * set itself and says so on screen, so the `proposed` rows below are deliberate
 * — they must not move the numbers.
 *
 * The three rules the widget is built to, and what each card is showing:
 *   1. the headline is the VERIFIED count, never the softer Tier-1 total
 *   2. every rail segment is a CONFIDENCE, not a tier
 *   3. recall has a labelled empty slot rather than being quietly omitted
 */

type Company = React.ComponentProps<typeof CoverageMeter>["rows"][number];

let n = 0;
function co(seed: Partial<Company> & Pick<Company, "name">): Company {
  n += 1;
  return {
    key: String(n),
    id: n,
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

const v = (name: string, ats: string, slug: string, method: string, source = "seed") =>
  co({ name, ats, slug, source, tier: 1, resolutionMethod: method });

const UNIVERSE: Company[] = [
  v("Ramp", "ashby", "ramp", "discover-ashby"),
  v("Mercury", "ashby", "mercury", "discover-ashby"),
  v("Databricks", "greenhouse", "databricks", "discover-greenhouse"),
  v("Stripe", "greenhouse", "stripe", "discover-greenhouse"),
  v("Plaid", "lever", "plaid", "discover-lever"),
  v("Northern Trust", "workday", "ntrs.wd1.myworkdayjobs.com/careers", "workday-redirect", "edgar"),
  v("Cboe Global Markets", "workday", "cboe.wd1.myworkdayjobs.com/careers", "workday-redirect", "edgar"),
  // Slugs mined from Common Crawl and never re-probed — Tier 1 on paper,
  // unverified in fact. This gap is the whole reason the headline is not
  // "9 of 12 Tier 1".
  co({ name: "Fifth Third Bank", ats: "greenhouse", slug: "fifththird", source: "commoncrawl", tier: 1, resolutionMethod: "ingested-slug" }),
  co({ name: "", ats: "greenhouse", slug: "loopreturns", source: "commoncrawl", tier: 1, resolutionMethod: "ingested-slug" }),
  // Aggregator-covered, lagged.
  co({ name: "Aon", ats: "icims", slug: "aon", source: "formadv", tier: 2, resolutionMethod: "aggregator" }),
  co({ name: "Abbott", ats: "icims", slug: "abbott", source: "formadv", tier: 2, resolutionMethod: "fingerprint" }),
  // No board found yet — nothing is pulled from these.
  co({ name: "Grainger", source: "paste" }),
  co({ name: "Northwestern Mutual Investment Services", source: "edgar" }),
  // Proposed: real rows, waiting on a human. The meter must ignore them, or it
  // would climb every time discovery ran and fall the moment somebody did their job.
  co({ name: "Wintrust Financial", ats: "greenhouse", slug: "wintrust", source: "dork", tier: 1, resolutionMethod: "discover-greenhouse", reviewState: "proposed" }),
  co({ name: "Discover Financial", source: "dork", reviewState: "proposed" }),
];

/** The default: headline, confidence rail, and the four-word legend. */
export function Universe() {
  return <CoverageMeter rows={UNIVERSE} />;
}

/**
 * "How this is counted", opened. Underneath: what each confidence means, the
 * per-tier breakdown, and the oracle's named empty slot — recall is not
 * measured, and the panel says so rather than letting 84% be read as it.
 */
export function CountingExplained() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[data-testid="coverage-toggle"]')?.click();
  }, []);
  return (
    <div ref={ref}>
      <CoverageMeter rows={UNIVERSE} />
    </div>
  );
}

/**
 * A universe somebody has only just started: pasted names, no boards resolved.
 * The rail is one grey band and the headline is honest about it — nothing is
 * being pulled yet.
 */
export function EarlyDays() {
  return (
    <CoverageMeter
      rows={[
        co({ name: "Grainger", source: "paste" }),
        co({ name: "Abbott", source: "paste" }),
        co({ name: "Wintrust Financial", source: "paste" }),
        co({ name: "Cboe Global Markets", source: "paste" }),
        co({ name: "Ramp", ats: "ashby", slug: "ramp", source: "seed", tier: 1, resolutionMethod: "discover-ashby" }),
      ]}
    />
  );
}
