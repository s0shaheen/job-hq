import { describe, expect, it } from "vitest";
import { absoluteUrl, MAX_LINKS, splitEntries } from "@/lib/quickadd/links";
import { companyFromUrl, parsePosting, titleFromHtml } from "@/lib/quickadd/parse";
import { isPrivateAddress, makeGuardedLookup, readPosting, ssrfAgent } from "@/lib/quickadd/fetch";
import { resolveJobLinks } from "@/lib/quickadd/resolve";
import { applyDraftEdit } from "@/lib/quickadd/draft";
import { jobKey } from "@/lib/import/job-key";
import { ResolveRateGate, RESOLVE_RATE_MESSAGE } from "@/lib/quickadd/rate";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { SupabaseDataSource } from "@/lib/data/supabase-source";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The quick-add resolve step, at the level where its promises are decidable.
 *
 * Each block below names the wrong answer it exists to refuse, because the
 * failure mode of a parser is never a crash — it is a plausible value nobody
 * checks. `tracker/quickadd.py` shipped one LLM call and a prompt ending
 * "never invent a value", which is a request, not a guarantee.
 */

describe("splitting a paste", () => {
  it("splits on newlines, commas and semicolons, exactly as the field says", () => {
    const entries = splitEntries("https://a.com/1\nhttps://b.com/2, https://c.com/3;https://d.com/4");
    expect(entries.map((e) => (e.kind === "url" ? e.url : e.text))).toEqual([
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
      "https://d.com/4",
    ]);
  });

  it("keeps free text as text, so it is never reported as an unreadable page", () => {
    expect(splitEntries("Ramp, Product Manager")).toEqual([
      { kind: "text", text: "Ramp" },
      { kind: "text", text: "Product Manager" },
    ]);
  });

  it("treats a bare host as a link, which is what an address bar hands you", () => {
    expect(splitEntries("boards.greenhouse.io/ramp/jobs/1")).toEqual([
      { kind: "url", url: "boards.greenhouse.io/ramp/jobs/1" },
    ]);
  });

  it("refuses a scheme that is not http(s) — javascript: is not a link", () => {
    // The counterexample that matters: this string reaches an href and a
    // fetcher. Classified as text, it reaches neither.
    expect(splitEntries("javascript:alert(1)")).toEqual([
      { kind: "text", text: "javascript:alert(1)" },
    ]);
    expect(absoluteUrl("javascript:alert(1)")).toBeNull();
  });

  it("drops duplicates and caps the paste", () => {
    expect(splitEntries("https://a.com/1\nhttps://a.com/1")).toHaveLength(1);
    const many = Array.from({ length: 40 }, (_, i) => `https://a.com/${i}`).join("\n");
    expect(splitEntries(many)).toHaveLength(MAX_LINKS);
  });
});

describe("reading a company out of a link", () => {
  it("takes the ATS slug", () => {
    expect(companyFromUrl("https://boards.greenhouse.io/ramp/jobs/4021775")?.value).toBe("Ramp");
    expect(companyFromUrl("https://jobs.lever.co/modern-treasury/abc")?.value).toBe(
      "Modern Treasury",
    );
    expect(companyFromUrl("https://ramp.myworkdayjobs.com/x")?.value).toBe("Ramp");
  });

  it("says NOTHING for an aggregator rather than naming the aggregator", () => {
    // The wrong answer this refuses: "LinkedIn" in the company slot of a Ramp
    // posting — a confidently wrong parse, which is worse than an absent one.
    expect(companyFromUrl("https://www.linkedin.com/jobs/view/123456")).toBeNull();
    expect(companyFromUrl("https://www.indeed.com/viewjob?jk=abc")).toBeNull();
  });

  it("carries its provenance, so the surface can print where it read it", () => {
    expect(companyFromUrl("https://jobs.ashbyhq.com/plaid/x")?.from).toBe("from the link");
  });
});

describe("reading a title out of a page", () => {
  it("prefers og:title and trims the employer suffix", () => {
    const html =
      '<meta property="og:title" content="Product Manager, Risk - Ramp" /><title>Ramp</title>';
    expect(titleFromHtml(html, "Ramp")?.value).toBe("Product Manager, Risk");
  });

  it("leaves a dash alone when it is not the company", () => {
    expect(titleFromHtml("<title>Product Manager - Risk</title>", "Ramp")?.value).toBe(
      "Product Manager - Risk",
    );
  });

  it("returns nothing for a page title that names the page, not the role", () => {
    expect(titleFromHtml("<title>Careers</title>", "Ramp")).toBeNull();
  });

  it("returns nothing at all when the page could not be read", () => {
    // The whole point of the unreadable branch: a null page yields a null
    // title, never a title reconstructed from the URL's slug.
    const parsed = parsePosting("https://jobs.ashbyhq.com/ramp/product-manager-risk", null);
    expect(parsed.title).toBeNull();
    expect(parsed.company?.value).toBe("Ramp");
  });
});

describe("the fetch guard", () => {
  it("calls every private and link-local range private", () => {
    for (const [address, family] of [
      ["127.0.0.1", 4],
      ["10.1.2.3", 4],
      ["172.16.0.1", 4],
      ["192.168.1.1", 4],
      ["169.254.169.254", 4], // the cloud metadata address
      ["100.64.0.1", 4],
      ["::1", 6],
      ["fd00::1", 6],
      ["fe80::1", 6],
      ["::ffff:127.0.0.1", 6],
    ] as const) {
      expect(isPrivateAddress(address, family), address).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34", 4)).toBe(false);
  });

  it("refuses a non-http scheme without resolving anything", async () => {
    let called = false;
    const read = await readPosting("file:///etc/passwd", async () => {
      called = true;
      return new Response("");
    });
    expect(called).toBe(false);
    expect(read.html).toBeNull();
    expect(read.unreadable).toBe("Couldn't read this posting.");
  });

  it("says the same sentence for a 404 as for a refusal", async () => {
    const read = await readPosting("https://example.com/gone", async () =>
      new Response("nope", { status: 404 }),
    );
    expect(read.unreadable).toBe("Couldn't read this posting.");
  });
});

describe("the connection-time guard (DNS rebinding)", () => {
  /**
   * The TOCTOU this closes: `refuseNonPublic` resolves the name once and
   * approves it, then the socket resolves it AGAIN — and an attacker's DNS
   * answers public the first time and 169.254.169.254 the second. So the
   * enforcement is the dispatcher's own lookup: the answer it validates is
   * the answer the socket dials. These tests drive that lookup with hostile
   * answers directly, because the whole point is what happens when the second
   * resolution disagrees with the first.
   */
  const answer =
    (list: { address: string; family: number }[]) =>
    ((_host: unknown, _opts: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, list)) as never;

  it("refuses a private address at the socket, whatever any earlier resolution said", async () => {
    const guarded = makeGuardedLookup(answer([{ address: "169.254.169.254", family: 4 }]));
    const err = await new Promise((resolve) =>
      guarded("rebinder.example", {}, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("HQ_NONPUBLIC_ADDRESS");
  });

  it("refuses the WHOLE answer when one address in it is private", async () => {
    // One public, one loopback: the mixed record is the attack, not a quirk —
    // the connector may pick either, so neither may pass.
    const guarded = makeGuardedLookup(
      answer([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    );
    const err = await new Promise((resolve) => guarded("mixed.example", {}, (e) => resolve(e)));
    expect((err as NodeJS.ErrnoException).code).toBe("HQ_NONPUBLIC_ADDRESS");
  });

  it("hands a public answer through untouched", async () => {
    const guarded = makeGuardedLookup(answer([{ address: "93.184.216.34", family: 4 }]));
    const [err, address, family] = await new Promise<unknown[]>((resolve) =>
      guarded("example.com", {}, (...args: unknown[]) => resolve(args)),
    );
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  it("carries the guarding agent on EVERY hop, including the redirect target", async () => {
    // An agent constructed but not passed protects nothing, and a redirect
    // hop that dropped it would reopen the hole one hop later. `fetchImpl`
    // captures what production fetch would receive.
    const dispatchers: unknown[] = [];
    const read = await readPosting("https://example.com/a", (async (
      _url: string,
      init?: RequestInit,
    ) => {
      dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
      return dispatchers.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://example.org/b" } })
        : new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch);
    expect(read.html).not.toBeNull();
    expect(dispatchers).toHaveLength(2);
    expect(dispatchers[0]).toBe(ssrfAgent);
    expect(dispatchers[1]).toBe(ssrfAgent);
  });
});

describe("resolving what was pasted", () => {
  const page = (html: string | null) => async () => ({
    html,
    unreadable: html == null ? "Couldn't read this posting." : null,
    finalUrl: "",
  });

  it("keeps the URL when the page cannot be read", async () => {
    const [link] = await resolveJobLinks("https://jobs.ashbyhq.com/ramp/pm-risk", {
      readPage: page(null),
      existing: async () => null,
    });
    expect(link.url).toBe("https://jobs.ashbyhq.com/ramp/pm-risk");
    expect(link.key).not.toBe("");
    expect(link.title).toBeNull();
    expect(link.unreadable).toBe("Couldn't read this posting.");
  });

  it("reports a posting the user already tracks instead of minting a second one", async () => {
    const [link] = await resolveJobLinks("https://boards.greenhouse.io/ramp/jobs/8814021", {
      readPage: page("<title>Product Manager, Core Platform - Ramp</title>"),
      existing: async (key) =>
        key === "greenhouse-8814021"
          ? { key, company: "Ramp", title: "Product Manager, Core Platform" }
          : null,
    });
    expect(link.duplicate).toEqual({
      key: "greenhouse-8814021",
      company: "Ramp",
      title: "Product Manager, Core Platform",
    });
  });

  it("never asks the network about free text", async () => {
    let fetched = 0;
    const [link] = await resolveJobLinks("Ramp Product Manager", {
      readPage: async () => {
        fetched += 1;
        return { html: null, unreadable: null, finalUrl: "" };
      },
      existing: async () => null,
    });
    expect(fetched).toBe(0);
    expect(link.title?.value).toBe("Ramp Product Manager");
    expect(link.key).toBe("");
  });
});

describe("the key a maximum-length link produces", () => {
  it("legitimately exceeds 200 characters and stays inside app_add_job's 2052", () => {
    // The #239 carry-over, as an executable fact: an unreadable posting
    // behind a long aggregator link has no title, so its identity falls back
    // to `url-<netloc><path>` — up to 4 + 2048 = 2052 characters. The #182
    // sketch's 200-char key cap would have refused this legitimate add, which
    // is why no client-side cap on the KEY exists (the action caps the URL at
    // 2048, company/title at 200 and the idem key at 200, each matching the
    // RPC's own bound). This test is the tripwire for anyone reintroducing
    // one.
    const base = "https://jobs.example-aggregator.com/";
    const url = `${base}${"a".repeat(2_048 - base.length)}`;
    expect(url.length).toBe(2_048);
    const key = jobKey({ url });
    expect(key.startsWith("url-")).toBe(true);
    expect(key.length).toBeGreaterThan(200);
    expect(key.length).toBeLessThanOrEqual(2_052);
  });
});

describe("the resolve rate gate", () => {
  it("allows the documented budget and refuses the call after it", () => {
    const gate = new ResolveRateGate(3, 1_000);
    expect(gate.allow("u1", 0)).toBe(true);
    expect(gate.allow("u1", 10)).toBe(true);
    expect(gate.allow("u1", 20)).toBe(true);
    expect(gate.allow("u1", 30)).toBe(false);
  });

  it("bounds each user separately — one user's abuse is not another's outage", () => {
    const gate = new ResolveRateGate(1, 1_000);
    expect(gate.allow("u1", 0)).toBe(true);
    expect(gate.allow("u1", 10)).toBe(false);
    expect(gate.allow("u2", 10)).toBe(true);
  });

  it("opens a fresh window when the old one has elapsed", () => {
    const gate = new ResolveRateGate(1, 1_000);
    expect(gate.allow("u1", 0)).toBe(true);
    expect(gate.allow("u1", 999)).toBe(false);
    expect(gate.allow("u1", 1_000)).toBe(true);
  });

  it("is wired into the Supabase source, before anything resolves", async () => {
    // The wiring proof: an agent constructed but not consulted bounds
    // nothing. A closed gate answers the refusal without touching the client
    // at all — the stub here would throw on any use, which is the assertion
    // that a refused call performs no lookup.
    const closed = { allow: () => false } as unknown as ResolveRateGate;
    const source = new SupabaseDataSource(
      new Proxy({}, { get: () => { throw new Error("a refused resolve must touch nothing"); } }) as SupabaseClient,
      "user-a",
      closed,
    );
    const refused = await source.resolveJobLinks({ pasted: "Ramp, Product Manager" });
    expect(refused).toEqual({ ok: false, kind: "error", message: RESOLVE_RATE_MESSAGE });

    // And an open gate answers the resolve itself — free text only, so the
    // resolver needs neither the network nor a real client. The `rpc` stub is
    // the DURABLE bound (#261), which the open gate falls through to: with the
    // in-memory pre-filter passing, the charge is what decides.
    const open = { allow: () => true } as unknown as ResolveRateGate;
    const allowed = new SupabaseDataSource(
      { rpc: async () => ({ data: 1, error: null }) } as unknown as SupabaseClient,
      "user-a",
      open,
    );
    const result = await allowed.resolveJobLinks({ pasted: "Ramp, Product Manager" });
    expect(result.ok).toBe(true);
  });
});

describe("the draft's idempotency key across edits", () => {
  const draft = {
    idem: "key-1",
    outcome: "failed" as const,
    company_: "Ramp",
    title_: "PM",
  };

  it("mints a fresh key when a failed row is edited — the edited row is a new gesture", () => {
    // The counterexample this refuses: a retry carrying corrected fields under
    // the old key. `app_add_job` refuses that with 22023 (same key, different
    // request fingerprint), so reusing the key buys an error toast at best and
    // a silently un-edited write under the pre-0026 contract at worst.
    const edited = applyDraftEdit(draft, { title_: "Product Manager, Risk" });
    expect(edited.idem).not.toBe("key-1");
    expect(edited.title_).toBe("Product Manager, Risk");
  });

  it("keeps the key when nothing has been attempted yet", () => {
    const edited = applyDraftEdit({ ...draft, outcome: "pending" as const }, { title_: "New" });
    expect(edited.idem).toBe("key-1");
  });

  it("keeps the key when the edit changes nothing — a retry is the same gesture", () => {
    // This is the case the e2e failed-write test pins from the browser side:
    // click Add again without touching a field, and the same key goes back.
    const edited = applyDraftEdit(draft, { company_: "Ramp" });
    expect(edited.idem).toBe("key-1");
  });
});

describe("the fixture write's replay contract (0026's request fingerprint)", () => {
  const args = {
    url: "https://boards.greenhouse.io/ramp/jobs/9990001",
    key: "greenhouse-9990001",
    company: "Ramp",
    title: "Product Manager, Risk",
    idempotencyKey: "idem-fp-1",
  };

  it("replays the same gesture instead of applying twice", async () => {
    const src = new FixtureDataSource([]);
    const first = await src.addJob(args);
    expect(first).toMatchObject({ ok: true, outcome: "added" });
    const again = await src.addJob({ ...args });
    expect(again).toEqual(first);
    // Whitespace-only differences are the SAME gesture: the fingerprint is
    // taken over the blank-trimmed values, exactly as `app_add_job` builds it.
    const padded = await src.addJob({ ...args, company: "  Ramp  " });
    expect(padded).toEqual(first);
  });

  it("refuses the key when it comes back with different arguments, as the RPC does", async () => {
    const src = new FixtureDataSource([]);
    await src.addJob(args);
    const reused = await src.addJob({ ...args, title: "Product Manager, Fraud Risk" });
    // 0026's message, verbatim — a fake that replayed on the key alone would
    // be more forgiving than production, and the fresh-key-on-edit rule above
    // would be untestable through the only source the tests can drive.
    expect(reused).toEqual({
      ok: false,
      kind: "error",
      message: "idempotency key already used by app_add_job with different arguments",
    });
  });
});
