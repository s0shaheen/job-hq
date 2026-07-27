import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dispose,
  GATE_DEFAULTS,
  normalizeGateConfig,
  type GateCriteriaInput,
  type GateRow,
} from "@/lib/gating/dispose";

/**
 * The TypeScript half of the two-language gate contract.
 *
 * `monitor/gates.py` decides what actually reaches a queue. This port decides
 * what the profile preview PROMISES will reach it — and if the two disagree by
 * one branch, the app states a number the engine then contradicts, silently,
 * for as long as it takes somebody to notice their queue is the wrong shape.
 * That is the same failure `job_key` produced (matrix row 140) and it gets the
 * same answer: one fixture, `tests/fixtures/gate-corpus.json`, asserted from
 * both languages. `tests/monitor/test_gate_corpus.py` is the other half.
 *
 * The fixture is at the REPO root rather than under `webapp/`, deliberately:
 * neither side owns it, and a case can be added from either language.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

type Corpus = {
  version: number;
  defaults: Record<string, unknown>;
  kinds: string[];
  cases: {
    id: string;
    why: string;
    config: GateCriteriaInput;
    row: GateRow;
    expect: [string, string];
  }[];
};

const corpus = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "gate-corpus.json"), "utf8"),
) as Corpus;

const reasonKind = (reason: string) => reason.split(":")[0];

describe("gate corpus", () => {
  it("loaded the fixture and it has cases", () => {
    // Without this every parametrised assertion below passes vacuously on an
    // empty array — matrix rows 92/130/163, a guard that cannot read its own
    // contract. A wrong REPO path would otherwise turn this file green.
    expect(corpus.cases.length).toBeGreaterThanOrEqual(50);
    expect(corpus.version).toBe(1);
  });

  for (const c of corpus.cases) {
    it(`${c.id}`, () => {
      const g = normalizeGateConfig(c.config);
      // `why` is the mutation reason: if this line goes red, that sentence says
      // what behaviour was lost.
      expect(dispose(c.row, g), c.why).toEqual(c.expect);
    });
  }

  it("agrees with the corpus about GateConfig's defaults", () => {
    // The corpus's `defaults` block is asserted to BE `GateConfig()` by the
    // pytest half, so pinning the TypeScript constants to it makes the defaults
    // part of the contract rather than a copy that once was true. A `yoeMax`
    // default of 5 here would pass every case that names yoe_max.
    expect({
      countries: corpus.defaults.countries,
      metros: corpus.defaults.metros,
      geoUnknown: corpus.defaults.geo_unknown,
      compMin: corpus.defaults.comp_min,
      compUnknown: corpus.defaults.comp_unknown,
      workModelExclude: corpus.defaults.work_model_exclude,
      yoeMax: corpus.defaults.yoe_max,
      yoeUnknown: corpus.defaults.yoe_unknown,
      seniorityExclude: corpus.defaults.seniority_exclude,
    }).toEqual(GATE_DEFAULTS);
  });

  it("covers every reason kind in the closed set", () => {
    // docs/PRODUCT-SPEC.md A2. A gate rule added on one side with no corpus row
    // is untested in BOTH languages — matrix row 79.
    const produced = new Set(
      corpus.cases.map((c) => reasonKind(dispose(c.row, normalizeGateConfig(c.config))[1])),
    );
    const missing = corpus.kinds.filter((k) => !produced.has(k));
    expect(missing, "reason kinds no corpus case produces").toEqual([]);
  });

  it("produces no reason kind outside the closed set", () => {
    // The other direction. A kind this port invents is a raw machine token in
    // front of a human, because `explainReason` renders an unknown one verbatim.
    for (const c of corpus.cases) {
      const kind = reasonKind(dispose(c.row, normalizeGateConfig(c.config))[1]);
      expect(corpus.kinds, `${c.id} produced ${kind}`).toContain(kind);
    }
  });
});
