import { describe, expect, it } from "vitest";

import { monogram } from "@/components/ds/logo-avatar";
import { logoSources, normalizeDomain } from "@/lib/logo";

/**
 * The logo source ladder (01 section 7), which is entirely a string problem.
 *
 * Nothing in `lib/logo.ts` fetches anything: it turns a value out of a free-text
 * column into addresses the browser will request in order. Two kinds of failure
 * are worth this many tests, and neither is visible on screen:
 *
 *   1. **A ladder that silently loses a rung.** logo.dev emitted second, or with
 *      an empty token, still renders: the browser gets a 4xx, `onError` fires,
 *      and every company falls to the favicon or the monogram. The page looks
 *      fine and the good logos are simply never seen.
 *   2. **A URL minted out of junk.** `company.domain` is free text. "not a
 *      domain", a company name, a half-typed scheme: any of them turned into a
 *      URL is a broken image at best and a request to somebody else's host at
 *      worst.
 *
 * Full strings are asserted rather than fragments, because "still contains
 * logo.dev" is exactly the assertion a swapped ladder sails through.
 */

const KEY = "pk_test123";
const LOGODEV = `https://img.logo.dev/ramp.com?token=${KEY}`;
const FAVICON = "https://www.google.com/s2/favicons?domain=ramp.com&sz=64";

describe("logoSources builds the ladder, best rung first", () => {
  it("answers an empty ladder when there is no domain", () => {
    // MUTATION: emit the favicon URL unconditionally (`if (!host)` dropped, or
    // the guard moved below the push). Every company with no domain then
    // requests `?domain=&sz=64`, which Google answers with a generic globe —
    // a wrong logo beside a company name, and the monogram never renders.
    expect(logoSources(null, KEY)).toEqual([]);
    expect(logoSources(undefined, KEY)).toEqual([]);
    expect(logoSources("", KEY)).toEqual([]);
    expect(logoSources("   ", KEY)).toEqual([]);
    // …and with no key either, which is the state of this branch today.
    expect(logoSources(null, undefined)).toEqual([]);
  });

  it("offers the favicon only when there is a domain but no key", () => {
    // MUTATION: push the logo.dev URL unconditionally. `?token=` (or
    // `?token=undefined`) is a request logo.dev rejects for every company, so
    // rung 1 is dead weight that costs a failed request per row before the
    // favicon is ever tried. THIS IS THE STATE THE BRANCH SHIPS IN:
    // NEXT_PUBLIC_LOGO_DEV_KEY is not set anywhere yet.
    expect(logoSources("ramp.com", undefined)).toEqual([FAVICON]);
    expect(logoSources("ramp.com", "")).toEqual([FAVICON]);
    expect(logoSources("ramp.com", "   ")).toEqual([FAVICON]);
    for (const url of logoSources("ramp.com", undefined)) {
      expect(url).not.toContain("logo.dev");
      expect(url).not.toContain("token");
    }
  });

  it("puts logo.dev FIRST and the favicon second when both are present", () => {
    // MUTATION: swap the two pushes. Both URLs are still there and both still
    // load, so nothing errors and nothing is logged — the app just shows a
    // 16px favicon everywhere instead of the real mark, forever.
    expect(logoSources("ramp.com", KEY)).toEqual([LOGODEV, FAVICON]);
    // Asserted as an ordered pair as well, so a future third rung appended in
    // the middle cannot pass by keeping both of these present.
    const ladder = logoSources("ramp.com", KEY);
    expect(ladder.indexOf(LOGODEV)).toBeLessThan(ladder.indexOf(FAVICON));
    expect(ladder).toHaveLength(2);
  });
});

describe("the domain is normalized, never used raw", () => {
  it("reduces a pasted URL to its bare host", () => {
    // MUTATION: use the raw string (`const host = (domain ?? "").trim()`).
    // `https://www.Ramp.com/careers?x=1` then becomes
    // `https://img.logo.dev/https%3A%2F%2Fwww.ramp.com%2Fcareers%3Fx%3D1`, a
    // 404 for every company whose domain cell holds a link — which is most of
    // them, because a person pastes what is in the address bar.
    expect(normalizeDomain("https://www.Ramp.com/careers?x=1")).toBe("ramp.com");
    expect(logoSources("https://www.Ramp.com/careers?x=1", KEY)).toEqual([LOGODEV, FAVICON]);
  });

  it("strips the scheme, the www label, the path, the query and the fragment", () => {
    // Each clause separately, because dropping any one of the four replaces
    // leaves a host that still looks plausible in a diff.
    expect(normalizeDomain("http://ramp.com")).toBe("ramp.com");
    expect(normalizeDomain("https://ramp.com")).toBe("ramp.com");
    expect(normalizeDomain("www.ramp.com")).toBe("ramp.com");
    expect(normalizeDomain("ramp.com/careers")).toBe("ramp.com");
    expect(normalizeDomain("ramp.com?utm=x")).toBe("ramp.com");
    expect(normalizeDomain("ramp.com#team")).toBe("ramp.com");
    expect(normalizeDomain("  RAMP.COM  ")).toBe("ramp.com");
    // MUTATION: strip "www." BEFORE the scheme. The order matters and only this
    // case shows it: "https://www.ramp.com" would keep the scheme.
    expect(normalizeDomain("https://www.ramp.com/")).toBe("ramp.com");
    // A subdomain that is not "www" is part of the host and stays.
    expect(normalizeDomain("jobs.ramp.com")).toBe("jobs.ramp.com");
    // Only a LEADING "www." is cosmetic.
    expect(normalizeDomain("www.www.ramp.com")).toBe("www.ramp.com");
  });

  it("takes the host out of credentials and drops the port", () => {
    // MUTATION: skip the `@` split. `evil.com@ramp.com` is a shape a URL parser
    // reads as "host ramp.com, user evil.com", and a naive strip keeps the whole
    // string, which then fails the hostname test and silently loses the logo —
    // or, with a looser pattern, points the request at evil.com.
    expect(normalizeDomain("https://evil.com@ramp.com/jobs")).toBe("ramp.com");
    expect(normalizeDomain("ramp.com:8443")).toBe("ramp.com");
  });
});

describe("a value that is not a hostname yields no URL at all", () => {
  const NOT_DOMAINS = [
    ["not a domain", "a phrase with spaces, which is what a name column holds"],
    ["ramp", "a company name: no dot, so not a host"],
    ["http://", "a scheme and nothing after it"],
    ["https://", "the same, secure"],
    ["Ramp Inc.", "a legal name, whose trailing dot is not a TLD"],
    ["javascript:alert(1)", "the reason this is an allowlist and not a trim"],
    ["ramp..com", "an empty label"],
    ["-ramp.com", "a label that starts with a hyphen"],
    ["ramp.com.", "a trailing dot, i.e. an empty final label"],
    ["/ramp.com", "a path, which has no authority at all"],
    ["ramp .com", "a space inside what looks like a host"],
  ] as const;

  it("refuses every one of them at the normalizer", () => {
    // MUTATION: replace the HOSTNAME test with `bare.length > 0`. Every string
    // above becomes a URL — encoded, well-formed, and completely wrong.
    for (const [value, why] of NOT_DOMAINS) {
      expect(normalizeDomain(value), `${JSON.stringify(value)}: ${why}`).toBe("");
    }
    // The positive control, without which a normalizer that returned "" for
    // everything would pass this whole block.
    expect(normalizeDomain("ramp.com")).toBe("ramp.com");
    expect(normalizeDomain("some-company.co.uk")).toBe("some-company.co.uk");
    expect(normalizeDomain("x9.io")).toBe("x9.io");
  });

  it("and therefore mints no URL from any of them", () => {
    // The assertion that actually protects the browser: the ladder is EMPTY, not
    // a ladder of one broken URL. Empty is what makes the component render the
    // monogram.
    for (const [value, why] of NOT_DOMAINS) {
      expect(logoSources(value, KEY), `${JSON.stringify(value)}: ${why}`).toEqual([]);
      expect(logoSources(value, undefined), `${JSON.stringify(value)}: ${why}`).toEqual([]);
    }
    // Positive control on the same call shape.
    expect(logoSources("ramp.com", KEY)).toHaveLength(2);
  });

  it("refuses a host longer than DNS allows", () => {
    // MUTATION: drop the length cap. A 10 KB cell becomes a 10 KB URL.
    expect(normalizeDomain(`${"a".repeat(250)}.com`)).toBe("");
    expect(normalizeDomain(`${"a".repeat(60)}.com`)).toBe(`${"a".repeat(60)}.com`);
  });
});

describe("nothing escapes its parameter", () => {
  it("URL-encodes the token", () => {
    // MUTATION: interpolate the key raw. A token is a secret somebody pastes
    // into an env var, and a stray `&` in it silently truncates the token and
    // invents a second parameter — an auth failure that looks like "logo.dev is
    // down" rather than like a typo in the environment.
    const url = logoSources("ramp.com", "a b&sz=1#x")[0];
    expect(url).toBe("https://img.logo.dev/ramp.com?token=a%20b%26sz%3D1%23x");
    expect(url.split("&")).toHaveLength(1); // no second parameter was invented
    expect(url).not.toContain("#"); // and no fragment
    const params = new URL(url).searchParams;
    expect([...params.keys()]).toEqual(["token"]);
    expect(params.get("token")).toBe("a b&sz=1#x");
  });

  it("cannot be injected through a crafted domain", () => {
    // MUTATION: interpolate the domain raw AND loosen the hostname test. The
    // defense is two-deep and both halves are asserted here.
    //
    // Half one: a domain carrying its own query is truncated at the `?`, so it
    // cannot append parameters to either rung.
    const favicon = logoSources("ramp.com?sz=1&evil=1", undefined)[0];
    expect(favicon).toBe(FAVICON);
    expect([...new URL(favicon).searchParams.keys()]).toEqual(["domain", "sz"]);
    expect(new URL(favicon).searchParams.get("sz")).toBe("64");

    // Half two: a domain carrying markup or a scheme never reaches the
    // interpolation at all.
    for (const hostile of [
      'ramp.com" onerror="alert(1)',
      "ramp.com<script>",
      "javascript:alert(1)",
      "data:text/html,x",
      "ramp.com\n.evil.com",
    ]) {
      expect(logoSources(hostile, KEY), hostile).toEqual([]);
    }

    // Every URL this module ever emits parses, and points at one of the two
    // hosts it is allowed to point at. Mutant: any future rung added without a
    // test — this catches the shape, not the spelling.
    for (const url of logoSources("ramp.com", KEY)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(["img.logo.dev", "www.google.com"]).toContain(parsed.host);
    }
  });
});

/**
 * `monogram` is rung 3, and the only rung that always works. It lives in the
 * component module rather than here because it renders rather than resolves,
 * and it is tested in this file because vitest runs jsdom with the react
 * plugin, so importing the TSX module costs nothing.
 */
describe("monogram", () => {
  it("takes the initials of the first two words", () => {
    // MUTATION: `name.slice(0, 2)` for every name. "General Motors" becomes
    // "GE" and "Goldman Sachs" becomes "GO", so two unrelated companies wear
    // near-identical marks in the same list.
    expect(monogram("General Motors")).toBe("GM");
    expect(monogram("Goldman Sachs")).toBe("GS");
    expect(monogram("Capital One Financial")).toBe("CO"); // first two words only
  });

  it("takes the first two letters of a single-word name", () => {
    expect(monogram("Ramp")).toBe("RA");
    expect(monogram("Stripe")).toBe("ST");
  });

  it("is upper case and deterministic", () => {
    // MUTATION: drop `.toUpperCase()`. The monogram is the fallback that every
    // company without a domain wears, so a lower-case one is a visible
    // inconsistency across most of the grid.
    expect(monogram("ramp")).toBe("RA");
    expect(monogram("Ramp")).toBe(monogram("ramp"));
  });

  it("survives the whitespace a pasted name carries", () => {
    // MUTATION: drop the `.trim()`. A leading space makes `split(/\s+/)` yield
    // an empty first word, and the monogram renders as a single letter or blank.
    expect(monogram("  Ramp  ")).toBe("RA");
    expect(monogram("  General   Motors ")).toBe("GM");
  });

  it("returns an empty string rather than throwing on an empty name", () => {
    // The contract the component depends on: a company row with no name must
    // render a blank chip, not a white screen.
    expect(monogram("")).toBe("");
    expect(monogram("   ")).toBe("");
    expect(monogram("X")).toBe("X");
  });
});
