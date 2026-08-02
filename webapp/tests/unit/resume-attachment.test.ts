import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CONTENT_TYPE,
  attachmentToken,
  artifactStoragePath,
  BUILT_IN_THEMES,
  isBuiltInTheme,
  parseAttachmentToken,
  publishGate,
  safeFilename,
  themeDeltas,
  type ResumeAttachmentRef,
} from "@/lib/resume/attachment";

/**
 * The attachment seam and the publish gate.
 *
 * Organised by the mutation each block kills, because every function here is
 * small enough that a test asserting the happy path proves nothing. The two
 * that matter most are `safeFilename` (it is the only thing between an upload
 * form and another user's storage prefix) and `publishGate`'s unknown-page
 * branch (it is the only thing between an unrendered draft and a real
 * application).
 */

const REF: ResumeAttachmentRef = {
  artifactId: 42,
  origin: "rendered",
  kind: "pdf",
  filename: "resume.pdf",
  byteSize: 38_204,
  sha256: "a".repeat(64),
  storagePath: "11111111-1111-1111-1111-111111111111/42/resume.pdf",
};

describe("the provenance token", () => {
  it("round-trips", () => {
    expect(parseAttachmentToken(attachmentToken(REF))).toEqual({
      origin: "rendered",
      artifactId: 42,
    });
    expect(
      parseAttachmentToken(attachmentToken({ ...REF, origin: "uploaded" })),
    ).toEqual({ origin: "uploaded", artifactId: 42 });
  });

  it("reads as an explanation to a human", () => {
    // The review surface prints this string verbatim next to the value. If the
    // format changes to something opaque, this is the test that argues.
    expect(attachmentToken(REF)).toBe("resume:rendered:42");
  });

  /**
   * Killing mutation: drop the `^`/`$` anchors from the regex in
   * `parseAttachmentToken`. Every one of these then parses, and a token
   * embedded in a longer attacker-influenced string is honoured.
   */
  it("refuses anything that is not exactly one of ours", () => {
    for (const bad of [
      "",
      "resume:rendered:",
      "resume:rendered:0",
      "resume:rendered:-1",
      "resume:rendered:1.5",
      "resume:invented:1",
      "answer:some-key",
      "policy:visa@ramp",
      " resume:rendered:42",
      "resume:rendered:42 ",
      "xresume:rendered:42",
      "resume:rendered:42x",
      "resume:rendered:42\nresume:rendered:1",
    ]) {
      expect(parseAttachmentToken(bad), bad).toBeNull();
    }
  });

  /**
   * Killing mutation: delete the `Number.isSafeInteger` guard. `Number` turns
   * this into 1e20, which is not the row anyone meant, and `\d+` alone lets it
   * through.
   */
  it("refuses an id that cannot survive being a JS number", () => {
    expect(parseAttachmentToken("resume:rendered:99999999999999999999")).toBeNull();
  });
});

describe("safeFilename — the only thing between an upload and another user's prefix", () => {
  /**
   * Killing mutation: remove the `.split(/[/\\]/).pop()`. The traversal cases
   * then survive into the storage key, and the leading segment of that key is
   * the owner — which is what the storage policy matches on.
   */
  it("cannot traverse out of the owner prefix", () => {
    for (const [input, expected] of [
      ["../../etc/passwd", "passwd"],
      ["..\\..\\windows\\system32", "system32"],
      ["/absolute/path/cv.pdf", "cv.pdf"],
      ["dir/../../cv.pdf", "cv.pdf"],
    ] as const) {
      expect(safeFilename(input), input).toBe(expected);
    }
    // And the composed key still has exactly the owner at the front.
    const key = artifactStoragePath("u-1", 7, "../../etc/passwd");
    expect(key).toBe("u-1/7/passwd");
    expect(key.startsWith("u-1/")).toBe(true);
  });

  /**
   * Killing mutation: drop the `.replace(/^[.-]+/, "")`. `.htaccess` and
   * `-rf` then survive — the first hides from every tool that lists a
   * directory, the second is read as a flag by every command that takes one.
   */
  it("refuses names that hide or that read as flags", () => {
    expect(safeFilename(".htaccess")).toBe("htaccess");
    expect(safeFilename("-rf")).toBe("rf");
    expect(safeFilename("...")).toBe("resume");
  });

  /** Killing mutation: return `cleaned` unconditionally — the key gains a trailing `/`. */
  it("never returns an empty final segment", () => {
    for (const empty of ["", "///", "!!!", "..", "/"]) {
      expect(safeFilename(empty), empty).toBe("resume");
      expect(artifactStoragePath("u", 1, empty).endsWith("/")).toBe(false);
    }
  });

  it("leaves an ordinary name alone and bounds a long one", () => {
    expect(safeFilename("Alex_Rivera-Resume.v2.pdf")).toBe("Alex_Rivera-Resume.v2.pdf");
    expect(safeFilename("a".repeat(500)).length).toBe(120);
  });
});

describe("the publish gate", () => {
  /**
   * Killing mutation: treat `pages === null` as passing (`if (pages === null)
   * return { ok: true }`). An unrendered draft then attaches to a real
   * application, which is the exact failure the gate exists to prevent.
   */
  it("refuses a version that has never been rendered", () => {
    for (const unknown of [null, 0, -1, Number.NaN]) {
      const g = publishGate(unknown, 1);
      expect(g.ok, String(unknown)).toBe(false);
      if (!g.ok) expect(g.reason).toBe("never-rendered");
    }
  });

  /** Killing mutation: `pages < pageTarget` instead of `<=` — an exact-fit résumé is refused. */
  it("passes at exactly the target", () => {
    expect(publishGate(1, 1).ok).toBe(true);
    expect(publishGate(2, 2).ok).toBe(true);
  });

  it("blocks over the target and says what to do about it", () => {
    const g = publishGate(2, 1);
    expect(g.ok).toBe(false);
    if (!g.ok && g.reason === "over-page-target") {
      expect(g.pages).toBe(2);
      expect(g.pageTarget).toBe(1);
      expect(g.message).toMatch(/2 pages/);
      // The cut order is the user's decision, so the message offers all three
      // routes rather than assuming they want to trim.
      expect(g.message).toMatch(/theme/);
    }
  });

  /**
   * Killing mutation: delete the `pageTarget === 0` branch. A deliberate
   * no-limit document (an academic CV — RenderCV's own stated audience) then
   * cannot be published at all, which is the bug that makes people set the
   * target to 99.
   */
  it("treats target 0 as no limit, not as zero pages", () => {
    expect(publishGate(4, 0).ok).toBe(true);
    expect(publishGate(1, 0).ok).toBe(true);
    // …but unknown is still unknown, even with no limit.
    expect(publishGate(null, 0).ok).toBe(false);
  });
});

describe("theme deltas — the preflight before a theme switch", () => {
  // The measured shape: harvard and ink hold one page where the other seven
  // spill, on content that is snug rather than roomy.
  //
  // Insertion order is DELIBERATELY not sorted order — the two-page themes come
  // first. An earlier version of this fixture listed them cheapest-first, which
  // made the ordering assertion below vacuous: dropping the sort entirely left
  // the output identical and the mutant survived.
  const PROBE = {
    opal: 2,
    classic: 2,
    harvard: 1,
    ember: 2,
    ink: 1,
  };

  it("reports the delta against the theme in use", () => {
    const d = themeDeltas(PROBE, "harvard", 1);
    const byTheme = Object.fromEntries(d.map((x) => [x.theme, x]));
    expect(byTheme.classic.delta).toBe(1);
    expect(byTheme.ink.delta).toBe(0);
    expect(byTheme.classic.overTarget).toBe(true);
    expect(byTheme.harvard.overTarget).toBe(false);
  });

  /**
   * Killing mutation: `delta: pages - (current ?? 0)`. Every theme then reports
   * its absolute page count as a delta, so switching looks catastrophic and the
   * preflight becomes noise people click through.
   */
  it("reports no delta rather than a fabricated one when the current theme was not probed", () => {
    const d = themeDeltas(PROBE, "moderncv", 1);
    expect(d.every((x) => x.delta === 0)).toBe(true);
    // The absolute count still carries the meaning.
    expect(d.find((x) => x.theme === "classic")?.pages).toBe(2);
  });

  /** Killing mutation: drop the sort — the cheapest theme stops being first. */
  it("puts the themes that fit first", () => {
    const d = themeDeltas(PROBE, "harvard", 1);
    expect(d.map((x) => x.theme)).toEqual(["harvard", "ink", "classic", "ember", "opal"]);
  });

  it("respects a no-limit target", () => {
    expect(themeDeltas(PROBE, "harvard", 0).every((x) => !x.overTarget)).toBe(true);
  });
});

describe("the theme allowlist", () => {
  it("is exactly the nine built-ins of the pinned rendercv 2.8", () => {
    // Pinned as a literal. If a version bump adds a tenth theme, this test is
    // the thing that makes someone decide whether it is offered, rather than it
    // appearing because a list somewhere grew.
    expect([...BUILT_IN_THEMES]).toEqual([
      "classic",
      "ember",
      "engineeringclassic",
      "engineeringresumes",
      "harvard",
      "ink",
      "moderncv",
      "opal",
      "sb2nov",
    ]);
  });

  /**
   * Killing mutation: implement `isBuiltInTheme` as a truthiness or prefix
   * check. `evil` is the theme name that makes RenderCV execute a folder's
   * `__init__.py` during validation.
   */
  it("refuses anything else, including the shapes that matter", () => {
    for (const bad of ["evil", "", "Harvard", "harvard/", "../harvard", "harvard "]) {
      expect(isBuiltInTheme(bad), bad).toBe(false);
    }
    for (const good of BUILT_IN_THEMES) expect(isBuiltInTheme(good)).toBe(true);
  });
});

describe("content types", () => {
  it("covers every artifact kind", () => {
    // A missing entry would upload a résumé as application/octet-stream, which
    // some ATSs silently reject.
    for (const kind of ["pdf", "docx", "png", "yaml"] as const) {
      expect(ARTIFACT_CONTENT_TYPE[kind]).toBeTruthy();
    }
    expect(ARTIFACT_CONTENT_TYPE.pdf).toBe("application/pdf");
  });
});
