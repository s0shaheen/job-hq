// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeFit } from "@/lib/warm/fit";
import type { WarmFitContext } from "@/lib/warm/fit";
import type { WarmCandidate } from "@/lib/warm/types";

/**
 * The fit pass (`analyzeFit`) — the LLM annotation that re-scores each candidate's
 * warmth. Three offline branches are pinned here, none of which touch the network:
 *
 *   empty          -> [] (the fail-safe: nothing to score, nothing to spend)
 *   not-demo+no-key -> input UNCHANGED, no `fit` attached (deterministic rank stands)
 *   demo           -> a DETERMINISTIC fit from the candidate's own baked signals,
 *                     offline, so the E2E can reach the fit UI without a key.
 *
 * The real Messages-API branch is NEVER exercised in a unit test — it requires a
 * key we deliberately never set, and `fetch` is stubbed to throw so an accidental
 * call fails loudly rather than reaching out.
 *
 * NODE ENVIRONMENT + server-only stub: `fit.ts` is `server-only`; the marker is a
 * throwing module under vitest, stubbed the way the vendor/handler suites do.
 */

vi.mock("server-only", () => ({}));

// Every branch under test is offline. Stub `fetch` to reject so a stray real call
// (the LLM branch) surfaces as a failure, not a silent network hit.
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("no network in a unit test")) as typeof fetchSpy;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ctx: WarmFitContext = {
  role: "Product Manager",
  company: "Ramp",
  schools: ["UIUC"],
  pastCompanies: [],
};

/** A ranked WarmCandidate with sane defaults; only `fullName` is required. */
function cand(over: Partial<WarmCandidate> & Pick<WarmCandidate, "fullName">): WarmCandidate {
  return {
    headline: "",
    company: "Ramp",
    location: "",
    years: "",
    linkedinUrl: "",
    isRecruiter: false,
    signals: [],
    score: 0,
    ...over,
  };
}

describe("analyzeFit — empty input", () => {
  it("returns [] and never spends", async () => {
    vi.stubEnv("HQ_DEMO", "1"); // even in demo, an empty list short-circuits
    const out = await analyzeFit([], ctx);
    // MUTATION: the `length === 0` guard removed -> a demo/LLM path runs on nothing.
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("analyzeFit — not demo, no key", () => {
  it("returns the candidates UNCHANGED with no fit attached — the deterministic rank stands", async () => {
    vi.stubEnv("HQ_DEMO", "");
    vi.stubEnv("NEXT_PUBLIC_HQ_DEMO", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const input = [
      cand({ fullName: "Ada", signals: [{ kind: "school", label: "UIUC" }] }),
      cand({ fullName: "Chen", isRecruiter: true, signals: [{ kind: "persona", label: "Recruiter" }] }),
    ];
    const out = await analyzeFit(input, ctx);

    // MUTATION: an unconfigured deployment tries the LLM anyway -> a real fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
    // MUTATION: attach a fit even without a key -> the "fail-safe = unchanged" contract breaks.
    for (const c of out) expect(c.fit).toBeUndefined();
    expect(out.map((c) => c.fullName)).toEqual(["Ada", "Chen"]);
  });
});

describe("analyzeFit — demo mode (deterministic, offline)", () => {
  it("scores school->strong, recruiter->medium, persona-only->weak, each with a reason, no network", async () => {
    vi.stubEnv("HQ_DEMO", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", ""); // NO key: fit still comes back => the branch is offline

    const school = cand({ fullName: "Bea", signals: [{ kind: "school", label: "UIUC" }] });
    const recruiter = cand({
      fullName: "Rex",
      isRecruiter: true,
      signals: [{ kind: "persona", label: "Recruiter" }],
    });
    const personaOnly = cand({ fullName: "Pat", signals: [{ kind: "persona", label: "In your role" }] });

    const [bea, rex, pat] = await analyzeFit([school, recruiter, personaOnly], ctx);

    // MUTATION: demo branch dropped -> no key means UNCHANGED, so these are undefined.
    expect(bea.fit?.tier).toBe("strong");
    expect(rex.fit?.tier).toBe("medium");
    expect(pat.fit?.tier).toBe("weak");
    // Transparent reasoning, never a bare number — every fit carries a non-empty reason.
    for (const c of [bea, rex, pat]) expect(c.fit?.reason.trim()).toBeTruthy();

    // The demo branch must NOT reach the Messages API — deterministic and offline.
    // MUTATION: demo path falls through to `fetch` -> this spy fires.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
