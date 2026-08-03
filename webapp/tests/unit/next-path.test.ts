import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, safeNextPath } from "@/lib/auth/next-path";

/**
 * The OAuth callback's `?next=`, as a pure function.
 *
 * WHAT THIS FILE DOES NOT PROVE, stated first because an earlier version of this
 * comment claimed it did. There was no reachable open redirect.
 * `app/auth/callback/route.ts` builds `${origin}${next}`, and the origin prefix
 * pins the host before the URL parser sees the attacker's text — measured, with
 * the numbers in `lib/auth/next-path.ts`. A crafted `next` could not send anyone
 * off-site, and saying otherwise put an exploit story in the repository that
 * nobody had watched fail.
 *
 * So `safeNextPath` is DEFENCE IN DEPTH: it makes the value safe on its own
 * terms, so that safety stops depending on a string concatenation two files away
 * staying exactly as it is. The property that protects users today — the
 * `Location` header names this origin — is asserted at the route in
 * `auth-callback.test.ts`, which is where it lives.
 *
 * THE COUNTEREXAMPLE, run: revert `safeNextPath` to `raw.startsWith("/") ? raw
 * : DEFAULT_NEXT` and the four protocol-relative cases below go red while every
 * other case stays green. That is the mutation this guard ships with.
 *
 * Asserted over a corpus rather than one string, because the property is about a
 * SHAPE and a single `//evil` case would pass a fix that only special-cased two
 * forward slashes.
 */
describe("safeNextPath", () => {
  it("keeps an ordinary in-app path", () => {
    for (const p of ["/queue", "/jobs?set=all", "/settings/preferences", "/apply/12"]) {
      expect(safeNextPath(p), p).toBe(p);
    }
  });

  it("refuses anything that leaves this origin", () => {
    for (const p of [
      // Protocol-relative: the actual hole.
      "//evil.example",
      "//evil.example/queue",
      // Backslash forms, which several browsers normalise to `//`.
      "/\\evil.example",
      "/\\\\evil.example",
      // Absolute, which the original check did already refuse.
      "https://evil.example",
      "http://evil.example/queue",
      // Scheme-ish things that are not paths at all.
      "javascript:alert(1)",
      "evil.example",
    ]) {
      expect(safeNextPath(p), p).toBe(DEFAULT_NEXT);
    }
  });

  it("refuses control characters, which URL parsing silently strips", () => {
    // FOUND BY A MUTATION, not by prediction. `new URL()` removes tabs, newlines
    // and carriage returns while parsing, so `/\t/evil.example` — one leading
    // slash, second character not a slash — passed every other check here and
    // then resolved to `//evil.example`. The route-level test caught it when the
    // origin prefix was mutated away; this is the same property asserted where
    // the guard lives.
    for (const p of [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\u0000/evil.example",
      "/ /evil.example",
      "/queue\u007f",
    ]) {
      expect(safeNextPath(p), JSON.stringify(p)).toBe(DEFAULT_NEXT);
    }
  });

  it("falls back to the front door for an absent or empty value", () => {
    expect(safeNextPath(null)).toBe(DEFAULT_NEXT);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNextPath("")).toBe(DEFAULT_NEXT);
  });

  it("defaults to the front door, not to a named surface", () => {
    // `/` resolves the Landing view preference. A default of `/queue` here would
    // pin every sign-in to the queue and make that setting unreachable on the
    // one path it describes.
    expect(DEFAULT_NEXT).toBe("/");
  });
});
