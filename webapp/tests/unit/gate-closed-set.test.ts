import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispose, normalizeGateConfig, type GateCriteriaInput, type GateRow } from "@/lib/gating/dispose";
import { explainReason, reasonSetting } from "@/lib/data/view-models";

/**
 * The reason vocabulary, end to end: what the gate can EMIT, what a person is
 * SHOWN for it, and which setting it points at.
 *
 * `explainReason` ends in a `default:` that returns the raw token, which is the
 * right fallback and the wrong outcome: the day the gate learns a new reason,
 * the queue's why-popover shows somebody the string `metro:Chicago` (matrix row
 * 86). Nothing else in the app can catch that — the string renders fine, it is
 * just machine text in a sentence slot.
 *
 * Every reason here is PRODUCED by running the corpus through `dispose`, not
 * hand-typed, so the strings under test are the strings the gate really makes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

type Corpus = {
  kinds: string[];
  cases: { id: string; config: GateCriteriaInput; row: GateRow }[];
};

const corpus = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "gate-corpus.json"), "utf8"),
) as Corpus;

/** kind -> one real reason string the gate produced for it. */
const produced = new Map<string, string>();
for (const c of corpus.cases) {
  const [, reason] = dispose(c.row, normalizeGateConfig(c.config));
  const kind = reason.split(":")[0];
  if (!produced.has(kind)) produced.set(kind, reason);
}

/**
 * The kinds that name a setting a person can go and widen. `""` is not a
 * refusal at all and `awaiting-tags` is the engine being behind — offering to
 * loosen a filter for either would be advice about the wrong problem.
 */
const NOT_A_SETTING = new Set(["", "awaiting-tags"]);

describe("disposition reason closed set", () => {
  it("renders every section 5 example with the specified sentence", () => {
    expect(explainReason("geo:India")).toBe("Location is India, outside your area");
    expect(explainReason("yoe:6>4")).toBe("Asks for 6+ years; your profile says 4");
    expect(explainReason("comp:<120k")).toBe("Pay is below your $120k minimum");
    expect(explainReason("work_model:onsite")).toBe(
      "On-site only; you excluded on-site",
    );
    expect(explainReason("title_exclude:sales")).toBe(
      'Title matches your excluded term "sales"',
    );
  });

  it("ran the corpus and produced reasons", () => {
    // Guards every loop below from passing over an empty map.
    expect(produced.size).toBeGreaterThanOrEqual(corpus.kinds.length);
  });

  it("no reason kind reaches explainReason's default branch", () => {
    for (const kind of corpus.kinds) {
      const reason = produced.get(kind);
      expect(reason, `no corpus case produces kind ${JSON.stringify(kind)}`).toBeDefined();
      const english = explainReason(reason as string);
      // The default branch returns the token verbatim. Anything else is a
      // sentence somebody wrote on purpose.
      expect(english, `explainReason fell through for ${JSON.stringify(reason)}`).not.toBe(reason);
      expect(english.trim().length).toBeGreaterThan(0);
    }
  });

  it("every reason that names a setting resolves to one", () => {
    // This is the G9 link: the empty state names a constraint and the name is a
    // link to the field that caused it. A kind with no mapping renders a dead
    // sentence with nothing to click.
    for (const kind of corpus.kinds) {
      const reason = produced.get(kind) as string;
      const setting = reasonSetting(reason);
      if (NOT_A_SETTING.has(kind)) {
        expect(setting, `${kind} must not point at a setting`).toBeNull();
      } else {
        expect(setting, `${JSON.stringify(reason)} points at no profile setting`).toBeTruthy();
      }
    }
  });

  it("an unknown kind renders a sentence, never the raw token", () => {
    // The default branch is correct BEHAVIOUR — the test above only says no
    // kind in the closed set may need it. A reason from a future engine must
    // still put something on screen.
    //
    // MUTATION REASON: restore `default: return r` and this fails. The old
    // branch printed the engine token verbatim ("brand-new-gate:whatever"),
    // which the copy spec bans outright: a reader learns nothing from it and
    // it reads as a bug. The token stays on `dispositionReason` for debugging.
    expect(explainReason("brand-new-gate:whatever")).toBe(
      "Filtered out by your search settings",
    );
    expect(explainReason("brand-new-gate:whatever")).not.toContain("brand-new-gate");
    expect(reasonSetting("brand-new-gate:whatever")).toBeNull();
  });
});
