import { describe, expect, it } from "vitest";
import { escapeHtml, lifecycleEmail } from "@/lib/email/templates";
import type { LifecycleSendKind } from "@/lib/email/store";

/**
 * The lifecycle templates (#203), asserted on the rendered artifact — the
 * acceptance criterion's own words. The attack list drives the cases:
 * template injection through a hostile name, the private-content rule (only
 * the account-state fact and the user's address/name), `Not listed` never
 * reaching an email, and every href passing the safe_href standard.
 */

const KINDS: LifecycleSendKind[] = [
  "lifecycle.activation",
  "lifecycle.suspension",
  "lifecycle.deletion_confirmation",
];

const FACTS = { email: "person@example.com", name: "Avery Example" };

describe("the three lifecycle templates", () => {
  it("each renders subject, text and html carrying the state fact and the address", () => {
    for (const kind of KINDS) {
      const msg = lifecycleEmail(kind, FACTS);
      expect(msg.to).toBe("person@example.com");
      expect(msg.subject).toContain("Job Search HQ");
      expect(msg.text).toContain("person@example.com");
      expect(msg.html).toContain("person@example.com");
      expect(msg.text.length).toBeGreaterThan(0);
      expect(msg.html.length).toBeGreaterThan(0);
    }
  });

  it("activation states active, suspension states suspended, deletion states deleted", () => {
    expect(lifecycleEmail("lifecycle.activation", FACTS).text).toContain("active");
    expect(lifecycleEmail("lifecycle.suspension", FACTS).text).toContain("suspended");
    expect(lifecycleEmail("lifecycle.deletion_confirmation", FACTS).text).toContain("deleted");
  });

  it("carries recipient facts only: no counts, no job words, no operator reason", () => {
    // The suspension template is the tempting one — 0027's `reason` column is
    // an operator note the user does not see, and the render call does not
    // even receive it, so this asserts the template's vocabulary instead.
    for (const kind of KINDS) {
      const msg = lifecycleEmail(kind, FACTS);
      // "Job" appears only inside the product name; everything else from the
      // private-content rule's list must be absent outright.
      for (const banned of [
        /resume/i,
        /\bnotes?\b/i,
        /\bapplications?\b/i,
        /\binterviews?\b/i,
        /\d+ (new|open|saved)/i,
      ]) {
        expect(msg.text, `${kind} text`).not.toMatch(banned);
        expect(msg.html, `${kind} html`).not.toMatch(banned);
      }
      expect(msg.text.replaceAll("Job Search HQ", "")).not.toMatch(/\bjobs?\b/i);
    }
  });

  it("never says Not listed: an absent name is omitted, not placeholdered", () => {
    for (const kind of KINDS) {
      const msg = lifecycleEmail(kind, { email: "person@example.com", name: "" });
      expect(msg.text).not.toContain("Not listed");
      expect(msg.html).not.toContain("Not listed");
      expect(msg.text).not.toMatch(/^Hi\b/m); // no greeting line at all
      expect(msg.html).not.toContain("<p>Hi");
    }
  });

  it("escapes a hostile name in the html and leaves the text part plain", () => {
    const hostile = `<img src=x onerror=alert(1)>"'&`;
    const msg = lifecycleEmail("lifecycle.activation", {
      email: "person@example.com",
      name: hostile,
    });
    expect(msg.html).not.toContain("<img");
    expect(msg.html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
    // text/plain has no parser to inject into; the name passes through as text.
    expect(msg.text).toContain(`Hi ${hostile},`);
  });

  it("renders the sign-in link only for activation, and only when the URL is safe", () => {
    const safe = lifecycleEmail("lifecycle.activation", { ...FACTS, appUrl: "https://hq.example.com/" });
    expect(safe.text).toContain("Sign in: https://hq.example.com/");
    expect(safe.html).toContain('href="https://hq.example.com/"');

    // Every href passes the safe_href standard: userinfo, non-http schemes and
    // encoded userinfo are refused, and refusal means NO link, never a repaired one.
    for (const bad of [
      "javascript:alert(1)",
      "https://evil.com\\@good.com",
      "https://user@example.com/",
      "https://%40example.com/",
      "/relative",
      "",
    ]) {
      const msg = lifecycleEmail("lifecycle.activation", { ...FACTS, appUrl: bad });
      expect(msg.html, bad).not.toContain("href=");
      expect(msg.text, bad).not.toContain("Sign in:");
    }

    // Non-activation mail carries no link even when a URL is offered: a
    // suspended account cannot sign in and a deleted one has nowhere to go.
    for (const kind of ["lifecycle.suspension", "lifecycle.deletion_confirmation"] as const) {
      const msg = lifecycleEmail(kind, { ...FACTS, appUrl: "https://hq.example.com/" });
      expect(msg.html).not.toContain("href=");
    }
  });

  it("fails loud on an unknown kind and a missing recipient", () => {
    expect(() =>
      lifecycleEmail("lifecycle.newsletter" as LifecycleSendKind, FACTS),
    ).toThrow(/no lifecycle template/);
    expect(() => lifecycleEmail("lifecycle.activation", { email: "  ", name: "" })).toThrow(
      /recipient address/,
    );
  });
});

describe("escapeHtml", () => {
  it("neutralizes the five metacharacters and nothing else", () => {
    expect(escapeHtml(`<>&"'plain`)).toBe("&lt;&gt;&amp;&quot;&#39;plain");
    expect(escapeHtml("no specials 123")).toBe("no specials 123");
  });
});
