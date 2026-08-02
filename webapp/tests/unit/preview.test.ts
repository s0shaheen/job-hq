import { describe, expect, it } from "vitest";
import {
  clampWindowDays,
  computePreview,
  titleCoverage,
  titleCoverageWarning,
  type PreviewPosting,
} from "@/lib/profile/preview";
import { BASE_CRITERIA, type ProfileCriteria } from "@/lib/profile/criteria";
import { PREVIEW_CORPUS } from "@/lib/data/preview-fixtures";
import { presetById } from "@/lib/profile/presets";

/**
 * The number this panel states is the whole reason anybody would trust it.
 * "Your metros filtered 412 of 430" sends somebody to a setting; a wrong count
 * sends them to the WRONG setting, which costs more than saying nothing.
 */

const NOW = "2026-07-21T15:00:00.000Z";
const OPTS = { windowDays: 30, now: NOW };

function posting(p: Partial<PreviewPosting> & { key: string }): PreviewPosting {
  return {
    company: "Ramp",
    title: "Product Manager",
    tags: { tagged_at: "2026-07-01", min_yoe: "2" },
    geo: { country: "United States" },
    lastSeen: "2026-07-20",
    status: "Seen",
    ...p,
  };
}

function criteria(over: Partial<ProfileCriteria> = {}): ProfileCriteria {
  return { ...BASE_CRITERIA, titles_include: ["product manager"], ...over };
}

describe("computePreview — counts", () => {
  it("every posting lands in exactly one bucket", () => {
    // The three numbers are shown side by side. If they do not add up to the
    // total, the panel is arithmetic nobody can check.
    const p = computePreview(PREVIEW_CORPUS, criteria(), OPTS);
    expect(p.corpusTotal).toBe(PREVIEW_CORPUS.length);
    expect(p.qualified + p.filtered + p.needsInfo).toBe(p.corpusTotal);
  });

  it("reports an empty corpus as zero rather than dividing by it", () => {
    const p = computePreview([], criteria(), OPTS);
    expect(p.corpusTotal).toBe(0);
    expect(p.binding).toBeNull();
    expect(titleCoverageWarning(p)).toBe(false);
  });

  it("counts the FIRST-HIT reason only, because the gate short-circuits", () => {
    // One posting that fails geo AND comp AND yoe reports geo, once. A
    // histogram that counted every rule a row breaks would total more than the
    // corpus and make every percentage a lie.
    const rows = [
      posting({
        key: "a",
        geo: { country: "India" },
        tags: { tagged_at: "2026-07-01", min_yoe: "9", comp_range: "$40,000" },
      }),
    ];
    const p = computePreview(rows, criteria({ comp_min: 150, yoe_max: 4 }), OPTS);
    expect(p.reasonCounts).toEqual({ geo: 1 });
  });

  it("caps each sample list at five and explains each one in English", () => {
    const p = computePreview(PREVIEW_CORPUS, criteria(), OPTS);
    expect(p.samples.qualified.length).toBeLessThanOrEqual(5);
    expect(p.samples.filtered.length).toBeLessThanOrEqual(5);
    for (const s of p.samples.filtered) {
      // A raw machine token in a sample line is matrix row 86 on a new surface.
      expect(s.explanation).not.toBe(s.reason);
      expect(s.explanation.length).toBeGreaterThan(0);
    }
  });

  it("carries no url on a sample, because the corpus does not return one", () => {
    // `app_preview_corpus` excludes it deliberately. A sample shaped like a
    // JobView would offer a link to "" — a shape that cannot hold a dead link
    // cannot render one.
    const p = computePreview(PREVIEW_CORPUS, criteria(), OPTS);
    expect(p.samples.qualified[0]).not.toHaveProperty("url");
  });
});

describe("computePreview — the binding constraint", () => {
  it("returns null when nothing was filtered", () => {
    const p = computePreview([posting({ key: "a" })], criteria(), OPTS);
    expect(p.filtered).toBe(0);
    expect(p.binding).toBeNull();
  });

  it("finds the comp floor that geo was hiding", () => {
    // THE case this whole design exists for. 30 foreign rows are filtered on
    // geo and 6 US rows on comp, so the histogram's top entry is geo by five to
    // one — and relaxing geo recovers NOTHING, because those rows then fail the
    // same comp floor. The binding constraint is comp, and only a relaxation
    // pass can see it.
    const rows: PreviewPosting[] = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push(
        posting({
          key: `foreign-${i}`,
          geo: { country: "India" },
          tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "$75,000 - $80,000" },
        }),
      );
    }
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        posting({
          key: `poor-${i}`,
          tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "$75,000 - $80,000" },
        }),
      );
    }
    for (let i = 0; i < 2; i += 1) {
      rows.push(
        posting({
          key: `good-${i}`,
          tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "$180,000 - $200,000" },
        }),
      );
    }

    const p = computePreview(rows, criteria({ comp_min: 150 }), OPTS);

    expect(p.reasonCounts.geo).toBe(30);
    expect(p.reasonCounts.comp).toBe(6);
    // A histogram would say "countries". Relaxation says "compMin".
    expect(p.binding?.field).toBe("comp_min");
    expect(p.binding?.setting).toBe("compMin");
    expect(p.binding?.recovers).toBe(6);
    // …and the example names a comp posting, not one of the five geo rows that
    // fill the sample list. That fallback scan is the half a reader would
    // assume works and would not.
    expect(p.binding?.sample).toMatch(/below your \$150k minimum/i);
  });

  it("names the metros a local search is refusing", () => {
    const rows = [
      posting({ key: "chi", geo: { country: "United States", metro: "Chicago" } }),
      posting({ key: "den-1", geo: { country: "United States", metro: "Denver" } }),
      posting({ key: "den-2", geo: { country: "United States", metro: "Denver" } }),
      posting({ key: "den-3", geo: { country: "United States", metro: "Denver" } }),
    ];
    const p = computePreview(rows, criteria({ metros: ["Chicago"] }), OPTS);
    expect(p.qualified).toBe(1);
    expect(p.binding?.field).toBe("metros");
    expect(p.binding?.setting).toBe("metros");
    expect(p.binding?.recovers).toBe(3);
  });

  it("keeps the first field on a tie, so the sentence does not flip", () => {
    const rows = [
      posting({ key: "geo-1", geo: { country: "India" } }),
      posting({
        key: "yoe-1",
        tags: { tagged_at: "2026-07-01", min_yoe: "9" },
      }),
    ];
    const c = criteria({ yoe_max: 4 });
    const first = computePreview(rows, c, OPTS).binding?.field;
    const second = computePreview(rows, c, OPTS).binding?.field;
    expect(first).toBe("countries");
    expect(second).toBe("countries");
  });

  it("breaks a comp tie toward the unstated-pay policy, not the floor", () => {
    // T6. Every comp refusal here is `comp-unknown`, so relaxing the POLICY and
    // removing the FLOOR each recover all four — a genuine tie. The tie must go
    // to the policy: telling somebody to delete their compensation floor when the
    // actual problem is that half the feed states no pay is advice about the
    // wrong thing. HEAD is correct and nothing was checking it.
    const rows = [
      posting({ key: "a", tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "" } }),
      posting({ key: "b", tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "" } }),
      posting({ key: "c", tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "Competitive" } }),
      posting({ key: "d", tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "DOE" } }),
    ];
    const p = computePreview(rows, criteria({ comp_min: 150, comp_unknown: "filter" }), OPTS);
    expect(p.reasonCounts["comp-unknown"]).toBe(4);
    expect(p.binding?.field).toBe("comp_unknown");
    expect(p.binding?.setting).toBe("compMin");
  });

  it("breaks a metro tie toward the metro list, not the unplaceable policy", () => {
    // T8. A `metro-unknown` row comes back either by clearing the metro list or
    // by switching `geo_unknown` to keep — another genuine tie, and this one goes
    // the other way: somebody running a local search is thinking about their metro
    // list, and `geo_unknown` is a policy attached to it. Also the case that
    // proves the ORDER is doing the work rather than the field names.
    const rows = [
      posting({ key: "a", geo: { country: "United States", metro: "" } }),
      posting({ key: "b", geo: { country: "United States", metro: "" } }),
      posting({ key: "c", geo: { country: "United States", metro: "" } }),
    ];
    const p = computePreview(rows, criteria({ metros: ["Chicago"] }), OPTS);
    expect(p.reasonCounts["metro-unknown"]).toBe(3);
    expect(p.binding?.field).toBe("metros");
    expect(p.binding?.setting).toBe("metros");
  });

  it("illustrates the binding field with a posting that field really refused", () => {
    // The sample used to be matched on the collapsed SETTING, and several reason
    // kinds share one anchor: `geo` and `geo-unknown` both map to `countries`. So
    // a `geo_unknown` sentence — "how unplaceable locations are handled" — could
    // be illustrated by a posting in India, which is a different fact entirely.
    // Verified by the reviewer in a browser.
    const rows = [
      // Five geo-filtered rows fill the sample list, so the scan past it runs.
      ...Array.from({ length: 5 }, (_, i) =>
        posting({ key: `india-${i}`, geo: { country: "India" } }),
      ),
      // …and six unplaceable ones, so `geo_unknown` is what binds.
      ...Array.from({ length: 6 }, (_, i) => posting({ key: `nowhere-${i}`, geo: {} })),
    ];
    const p = computePreview(rows, criteria(), OPTS);
    expect(p.binding?.field).toBe("geo_unknown");
    // The example must describe an unidentifiable location, never India.
    expect(p.binding?.sample).toMatch(/could not be identified/i);
    expect(p.binding?.sample).not.toMatch(/India/i);
  });

  it("renders no example rather than a wrong one", () => {
    // When the binding field filtered nothing carrying a reason of its own, the
    // sample is empty and the panel omits the line. An unrelated posting under
    // "for example" is worse than no example.
    const rows = [posting({ key: "a", geo: { country: "India" } })];
    const p = computePreview(rows, criteria({ yoe_max: 4 }), OPTS);
    expect(p.binding?.field).toBe("countries");
    expect(p.binding?.sample).toMatch(/outside your area/i);
  });

  it("points every relaxable field at an anchor /settings actually has", () => {
    // The constraint's name is a LINK. A field mapping to an id nothing renders
    // is a dead end on the one screen whose job is getting somebody unstuck.
    const anchors = new Set([
      "countries",
      "metros",
      "yoeMax",
      "seniorityExclude",
      "compMin",
      "workModelExclude",
    ]);
    const cases: [string, ProfileCriteria, PreviewPosting][] = [
      ["countries", criteria(), posting({ key: "a", geo: { country: "India" } })],
      [
        "metros",
        criteria({ metros: ["Chicago"] }),
        posting({ key: "b", geo: { country: "United States", metro: "Denver" } }),
      ],
      [
        "yoeMax",
        criteria({ yoe_max: 4 }),
        posting({ key: "c", tags: { tagged_at: "2026-07-01", min_yoe: "9" } }),
      ],
      [
        "seniorityExclude",
        criteria({ seniority_exclude: ["Director"] }),
        posting({ key: "d", tags: { tagged_at: "2026-07-01", seniority: "Director" } }),
      ],
      [
        "compMin",
        criteria({ comp_min: 200 }),
        posting({ key: "e", tags: { tagged_at: "2026-07-01", min_yoe: "2", comp_range: "$90,000" } }),
      ],
      [
        "workModelExclude",
        criteria({ work_model_exclude: ["onsite"] }),
        posting({ key: "f", tags: { tagged_at: "2026-07-01", min_yoe: "2", work_model: "Onsite" } }),
      ],
      [
        "countries",
        criteria({ geo_unknown: "filter" }),
        posting({ key: "g", geo: {} }),
      ],
    ];
    for (const [expected, c, row] of cases) {
      const p = computePreview([row], c, OPTS);
      expect(p.binding, `${expected}: nothing bound`).toBeTruthy();
      expect(p.binding?.setting, `${row.key}`).toBe(expected);
      expect(anchors.has(p.binding?.setting as string)).toBe(true);
    }
  });
});

describe("computePreview — title coverage", () => {
  it("fires the banner for a role family the engine has never swept", () => {
    // Dad's real situation, and the reason the preview reports two numbers
    // rather than one. Folding "the engine is not fetching your titles yet"
    // into "0 qualified" is a lie in the one place this product cannot afford
    // one, because the user's conclusion is "it is broken".
    const fpa = presetById("fpa");
    const p = computePreview(
      PREVIEW_CORPUS,
      criteria({
        titles_include: fpa?.criteria.titles_include ?? [],
        titles_exclude: fpa?.criteria.titles_exclude ?? [],
      }),
      OPTS,
    );
    expect(p.titleMatched).toBeGreaterThan(0); // not a division with no numerator
    expect(p.titleMatched / p.corpusTotal).toBeLessThan(0.05);
    expect(titleCoverageWarning(p)).toBe(true);
  });

  it("stays quiet for the role family the corpus is full of", () => {
    const pm = presetById("product-manager");
    const p = computePreview(
      PREVIEW_CORPUS,
      criteria({
        titles_include: pm?.criteria.titles_include ?? [],
        titles_exclude: pm?.criteria.titles_exclude ?? [],
      }),
      OPTS,
    );
    expect(titleCoverageWarning(p)).toBe(false);
    expect(p.titleMatched / p.corpusTotal).toBeGreaterThan(0.5);
  });

  it("counts titles independently of the gate", () => {
    // A posting can match the titles and still be filtered on geo. Reporting
    // titleMatched as a subset of qualified would make the banner fire for
    // people whose only problem is a narrow country list.
    const rows = [posting({ key: "a", geo: { country: "India" } })];
    const p = computePreview(rows, criteria(), OPTS);
    expect(p.titleMatched).toBe(1);
    expect(p.qualified).toBe(0);
  });

  it("treats an empty include list as matching nothing", () => {
    // `any([])` is false in Python and `some()` is false here. A half-finished
    // profile must read as "no titles configured", never as "everything".
    const p = computePreview([posting({ key: "a" })], criteria({ titles_include: [] }), OPTS);
    expect(p.titleMatched).toBe(0);
    expect(p.titlesConfigured).toBe(0);
  });

  it("distinguishes 'you listed no titles' from 'the engine is behind'", () => {
    // These were ONE boolean, and the recorded visual baseline is what showed
    // what that costs: the panel told somebody who had not filled the field in
    // that "the engine has not been sweeping for this kind of role yet". One is
    // fixed by typing, the other by waiting, and naming the wrong one sends a
    // person to change a setting that was right.
    const rows = [posting({ key: "a" }), posting({ key: "b" })];

    const none = computePreview(rows, criteria({ titles_include: [] }), OPTS);
    expect(titleCoverage(none)).toBe("no-titles");

    const behind = computePreview(rows, criteria({ titles_include: ["treasury analyst"] }), OPTS);
    expect(behind.titlesConfigured).toBe(1);
    expect(titleCoverage(behind)).toBe("engine-behind");

    const fine = computePreview(rows, criteria(), OPTS);
    expect(titleCoverage(fine)).toBe("ok");
  });

  it("says nothing about coverage on an empty corpus with titles set", () => {
    // 0/0 is 0%, and reporting that would warn every user of a brand-new
    // deployment about titles that are perfectly fine.
    const p = computePreview([], criteria(), OPTS);
    expect(titleCoverage(p)).toBe("ok");
    expect(titleCoverageWarning(p)).toBe(false);
  });
});

describe("clampWindowDays", () => {
  it("applies the SQL's own bound, so the rendered number is the real one", () => {
    // `least(greatest(coalesce(p_days, 30), 1), 90)`. The Supabase source clamped
    // the value it SENT and handed the panel the raw one, so asking for 3,650 days
    // produced "collected in the last 3650 days" over a 90-day corpus — a false
    // number on the one screen whose entire job is a number somebody can trust.
    // The fake clamped properly, which is the wrong way round for a fake and is
    // what would have hidden it.
    expect(clampWindowDays(undefined)).toBe(30);
    expect(clampWindowDays(30)).toBe(30);
    expect(clampWindowDays(3650)).toBe(90);
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-7)).toBe(1);
    expect(clampWindowDays(7.9)).toBe(7);
    expect(clampWindowDays(Number.NaN)).toBe(30);
  });

  it("reports the clamped window in the result the panel renders", () => {
    const p = computePreview([posting({ key: "a" })], criteria(), {
      windowDays: clampWindowDays(3650),
      now: NOW,
    });
    expect(p.windowDays).toBe(90);
  });
});
