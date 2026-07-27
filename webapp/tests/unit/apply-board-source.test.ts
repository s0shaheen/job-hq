import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `board-source.ts` starts with `import "server-only"`, whose whole job is to
// throw when a client bundle reaches it. Stubbed so the module can be imported
// from a test at all — the same line `read.test.ts` carries, for the same reason.
vi.mock("server-only", () => ({}));

const { getBoardSource } = await import("@/lib/apply/board-source");

/**
 * The outbound board fetch, and the one property no other test can reach: the
 * BOUND on what it will read.
 *
 * The cap used to be advisory. It gated on the DECLARED `content-length` and then
 * called `res.json()`, so a body that declared nothing — a chunked response, a
 * proxy, `Number("abc")` — was read in full: an unbounded server-side allocation
 * on a `force-dynamic` page, needing only the other end to be dishonest or
 * careless about its own size.
 *
 * Driven through a stubbed `fetch` rather than a network, because the thing under
 * test is what this code does with a stream and there is no way to make a real
 * board send 20 MB.
 */

const MAX = 2_000_000;

/** A response whose body arrives in chunks, declaring whatever the caller says. */
function streamed(bytes: number, headers: Record<string, string> = {}): Response {
  const chunk = new Uint8Array(64 * 1024);
  chunk.fill(0x20); // spaces: valid UTF-8, invalid JSON, and big
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const take = Math.min(chunk.byteLength, bytes - sent);
      sent += take;
      controller.enqueue(chunk.subarray(0, take));
    },
  });
  return new Response(body, { status: 200, headers });
}

function json(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // `getBoardSource()` answers the fixture source in demo mode, which never
  // fetches. These tests are about the live one.
  vi.stubEnv("HQ_DEMO", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const REF = { boardToken: "acme", jobId: "12345" };

describe("the board fetch is bounded by what it reads, not by what it is told", () => {
  it("REGRESSION: an oversized body with NO content-length is refused", async () => {
    fetchMock.mockResolvedValue(streamed(MAX + 512 * 1024));
    const result = await getBoardSource().form(REF);
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      message: "The board's answer was too large.",
    });
  });

  it("…and a NON-NUMERIC content-length does not buy an exemption", async () => {
    // `Number("abc")` is NaN, so the declared-length check skips it — which was
    // the whole hole, and is now merely an early exit that did not fire.
    fetchMock.mockResolvedValue(streamed(MAX + 512 * 1024, { "content-length": "abc" }));
    expect(await getBoardSource().form(REF)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("still refuses on the declared length alone, without reading a byte", async () => {
    // The cheap early exit is kept: there is no reason to stream 2 MB to learn
    // what the header already said.
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("the body was read after the declared length refused it");
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-length": String(MAX + 1) } }),
    );
    expect(await getBoardSource().form(REF)).toMatchObject({
      ok: false,
      message: "The board's answer was too large.",
    });
  });

  it("reads a real payload unchanged, so the bound is not simply total", async () => {
    fetchMock.mockResolvedValue(json({ id: 7, questions: [] }));
    const result = await getBoardSource().form(REF);
    expect(result).toEqual({ ok: true, payload: { id: 7, questions: [] } });
  });

  it("a body that is not JSON is 'not a job posting', not a crash", async () => {
    fetchMock.mockResolvedValue(new Response("<html>nope</html>", { status: 200 }));
    expect(await getBoardSource().form(REF)).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("the request itself carries no credentials and cannot follow a redirect", async () => {
    fetchMock.mockResolvedValue(json({ id: 7, questions: [] }));
    await getBoardSource().form(REF);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345?questions=true",
    );
    expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(init.credentials).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
