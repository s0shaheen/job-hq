import { describe, expect, it } from "vitest";
import {
  atsOfPostingKey,
  greenhouseFormUrl,
  greenhouseJobIdFromUrl,
  greenhouseRefFromUrl,
  httpUrlOrEmpty,
  resolveApplyTarget,
} from "@/lib/apply/board";

/**
 * Which board a row points at.
 *
 * The interesting half is what this REFUSES, because every refusal here is a
 * request that is never made: the fetch URL is built from a board token and a
 * job id this file has checked against anchored patterns, against a literal
 * host, so a posting's own URL cannot become a request to somewhere else.
 */
describe("reading a Greenhouse posting URL", () => {
  it("takes the board and the job from the canonical shape", () => {
    expect(greenhouseRefFromUrl("https://boards.greenhouse.io/stripe/jobs/4410982")).toEqual({
      boardToken: "stripe",
      jobId: "4410982",
    });
    // The newer host, the EU host, a trailing path and a query — all the same job.
    expect(greenhouseRefFromUrl("https://job-boards.greenhouse.io/ramp/jobs/8814021")).toEqual({
      boardToken: "ramp",
      jobId: "8814021",
    });
    expect(
      greenhouseRefFromUrl("https://boards.eu.greenhouse.io/monzo/jobs/12345#app"),
    ).toEqual({ boardToken: "monzo", jobId: "12345" });
    expect(
      greenhouseRefFromUrl("https://boards.greenhouse.io/Stripe/jobs/4410982?gh_src=abc"),
    ).toEqual({ boardToken: "stripe", jobId: "4410982" });
  });

  it("refuses every shape that does not name BOTH halves", () => {
    // The embed's `token` is the JOB id wearing the board parameter's name.
    // Treating it as a board builds a URL for a board that does not exist, and
    // the request then 404s against somebody else's namespace.
    expect(greenhouseRefFromUrl("https://boards.greenhouse.io/embed/job_app?token=4410982")).toBeNull();
    // A company's own careers page: the job id is there, the board is not.
    expect(greenhouseRefFromUrl("https://stripe.com/jobs/listing?gh_jid=4410982")).toBeNull();
    expect(greenhouseRefFromUrl("https://example.com/jobs/greenhouse-4410982")).toBeNull();
    expect(greenhouseRefFromUrl("")).toBeNull();
    expect(greenhouseRefFromUrl(null)).toBeNull();
    // Not a URL at all — `new URL()` throws where Python's urlparse returns an
    // empty netloc, which is matrix row 140's trap one module over.
    expect(greenhouseRefFromUrl("boards.greenhouse.io/stripe/jobs/1")).toBeNull();
    // A host that merely CONTAINS the name, and one that merely ENDS with it.
    // The second is the one a bare `endsWith` waves through.
    expect(greenhouseRefFromUrl("https://greenhouse.io.evil.com/stripe/jobs/1")).toBeNull();
    expect(greenhouseRefFromUrl("https://notgreenhouse.io/stripe/jobs/1")).toBeNull();
    expect(greenhouseJobIdFromUrl("https://notgreenhouse.io/x/jobs/4410982")).toBeNull();
    // A job id that is not one.
    expect(greenhouseRefFromUrl("https://boards.greenhouse.io/stripe/jobs/abc")).toBeNull();
  });

  it("finds the job id alone in the shapes that carry one", () => {
    expect(greenhouseJobIdFromUrl("https://boards.greenhouse.io/embed/job_app?token=4410982")).toBe(
      "4410982",
    );
    expect(greenhouseJobIdFromUrl("https://stripe.com/jobs/listing?gh_jid=4410982")).toBe("4410982");
    expect(greenhouseJobIdFromUrl("https://example.com/careers/pm")).toBeNull();
  });
});

describe("what Prepare can do with a row", () => {
  it("names the ATS family when it is one this build cannot read", () => {
    expect(atsOfPostingKey("ashby-3f21a9c4")).toBe("ashby");
    expect(atsOfPostingKey("workday-R_1472470")).toBe("workday");
    expect(atsOfPostingKey("nodash")).toBeNull();

    // Named rather than lumped into "cannot read this", because the sentence a
    // person needs is "Ashby is not built yet" and not "something went wrong".
    expect(
      resolveApplyTarget({
        postingKey: "ashby-3f21a9c4",
        url: "https://jobs.ashbyhq.com/plaid/3f21a9c4",
      }),
    ).toEqual({ kind: "unsupported-ats", ats: "ashby" });
  });

  it("trusts the posting KEY for the family and the URL for the board", () => {
    // A Greenhouse posting whose stored URL is the company's own careers page:
    // the family is known from the key this system minted, and the board is not.
    expect(
      resolveApplyTarget({
        postingKey: "greenhouse-4410982",
        url: "https://stripe.com/jobs/listing?gh_jid=4410982",
      }),
    ).toEqual({ kind: "no-board", jobId: "4410982" });

    expect(
      resolveApplyTarget({
        postingKey: "greenhouse-4410982",
        url: "https://boards.greenhouse.io/stripe/jobs/4410982",
      }),
    ).toEqual({ kind: "greenhouse", boardToken: "stripe", jobId: "4410982" });
  });

  it("reads a fully-qualified host, trailing dot and all", () => {
    // `boards.greenhouse.io.` is a real, resolvable spelling of the same host, and
    // the dot-anchored suffix check refused it — a false negative that read a
    // Greenhouse posting as somebody else's.
    expect(greenhouseRefFromUrl("https://boards.greenhouse.io./acme/jobs/1")).toEqual({
      boardToken: "acme",
      jobId: "1",
    });
    // …and the thing the anchor is FOR still fails.
    expect(greenhouseRefFromUrl("https://notgreenhouse.io/acme/jobs/1")).toBeNull();
    expect(greenhouseRefFromUrl("https://greenhouse.io.evil.com/acme/jobs/1")).toBeNull();
  });

  it("answers `unknown` when there is nothing to go on", () => {
    // A row somebody typed in, or one imported from a spreadsheet: no key, no
    // board link. There is no form to read and no guess to make.
    expect(resolveApplyTarget({ postingKey: null, url: "https://example.com/jobs/manual-1" })).toEqual(
      { kind: "unknown" },
    );
    expect(resolveApplyTarget({ postingKey: null, url: null })).toEqual({ kind: "unknown" });
    // …and a keyless row whose URL IS a Greenhouse board is fetchable, because
    // both halves are there.
    expect(
      resolveApplyTarget({ postingKey: null, url: "https://boards.greenhouse.io/ramp/jobs/1" }),
    ).toEqual({ kind: "greenhouse", boardToken: "ramp", jobId: "1" });
  });
});

describe("a URL that becomes an href", () => {
  /**
   * `lib/referral/linkedin.ts`'s `connectionUrl` is the house pattern and its
   * comment names the failure: "a CSV cell is a place a `javascript:` string can
   * live". A Greenhouse payload's `absolute_url` is the same class of value and it
   * reached the DOM unchecked — React 19 neuters `javascript:` and nothing else,
   * so `data:` and `vbscript:` landed verbatim.
   */
  it("refuses every scheme but http and https", () => {
    for (const hostile of [
      "javascript:window.__p=1",
      "JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "gopher://boards.greenhouse.io/",
      "  javascript:alert(1)  ",
    ]) {
      expect(httpUrlOrEmpty(hostile), hostile).toBe("");
    }
  });

  it("keeps the ordinary ones exactly as they are", () => {
    expect(httpUrlOrEmpty("https://boards.greenhouse.io/stripe/jobs/1")).toBe(
      "https://boards.greenhouse.io/stripe/jobs/1",
    );
    expect(httpUrlOrEmpty("http://example.com/x?y=1#z")).toBe("http://example.com/x?y=1#z");
    expect(httpUrlOrEmpty("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("answers empty for anything a server render could not link to", () => {
    expect(httpUrlOrEmpty(null)).toBe("");
    expect(httpUrlOrEmpty(undefined)).toBe("");
    expect(httpUrlOrEmpty("   ")).toBe("");
    // A relative path has no base to mean anything against here, so it is not
    // "safe" — it is unusable, and "" is what the callers render as no link.
    expect(httpUrlOrEmpty("/careers/1")).toBe("");
    expect(httpUrlOrEmpty("not a url")).toBe("");
  });
});

describe("the fetch URL", () => {
  it("is built from the checked halves, against a literal host", () => {
    expect(greenhouseFormUrl({ boardToken: "stripe", jobId: "4410982" })).toBe(
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/4410982?questions=true",
    );
    // `?questions=true` is the whole point: without it the API answers the same
    // job shape MINUS the questions, and `parseGreenhouseForm` throws rather than
    // staging a form with nothing in it.
    expect(greenhouseFormUrl({ boardToken: "a", jobId: "1" })).toContain("questions=true");
  });

  it("refuses to build one from a ref that was not checked", () => {
    // The belt behind the parser's braces. Both halves are validated on the way
    // in, so this is unreachable through `greenhouseRefFromUrl` — and it is the
    // line that would matter the day somebody constructs a ref by hand.
    expect(() => greenhouseFormUrl({ boardToken: "../../etc", jobId: "1" })).toThrow();
    expect(() =>
      greenhouseFormUrl({ boardToken: "stripe", jobId: "1?x=y" }),
    ).toThrow();
    expect(() =>
      greenhouseFormUrl({ boardToken: "evil.com/boards", jobId: "1" }),
    ).toThrow();
  });
});
