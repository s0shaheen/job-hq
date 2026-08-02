// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";

/**
 * `POST /api/import/upload`, called with real `Request`s — the 311 lines nothing
 * but a browser had ever entered.
 *
 * The browser can only send the shapes the form produces, and the whole point of
 * this handler is the shapes it does NOT: an `.xls` wearing an `.xlsx` name, a
 * password-protected workbook, a 40 MB declaration, a paste with nothing in it, a
 * file with 5,001 rows. Each of those has a sentence a person can act on, and
 * until this file existed no test read one.
 *
 * **Node environment, deliberately.** jsdom's `Request`/`FormData` are not the
 * ones `request.formData()` parses, and a route tested through a stand-in body is
 * a route tested against a fake of the thing under test. The fixtures are read
 * from disk as bytes for the same reason `build-fixtures.mjs` writes them as
 * bytes.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

const { cookieJar, sourceRef, configuredRef } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  sourceRef: { current: null as unknown },
  configuredRef: { current: true },
}));

// `getSessionEntitlement` is here because the route now calls
// `refuseUnlessEntitled()` before it reads a byte of the upload (migration 0027):
// an account that is not turned on must not be able to stage rows, and this is a
// route the middleware redirect does not protect — a POST straight at the endpoint
// never passes a redirect. The mock answers ACTIVE so every case below still
// exercises the import logic it was written for; the refusal itself is proved in
// `entitlement-gate.test.ts`, which owns that behaviour.
vi.mock("@/lib/data/get-source", () => ({
  getDataSource: async () => sourceRef.current,
  isConfigured: () => configuredRef.current,
  getSessionEntitlement: async () => ({
    kind: "ok" as const,
    entitlement: { status: "active" as const, invited: true, plan: "free", activatedAt: null },
  }),
}));

const { POST, GET } = await import("@/app/api/import/upload/route");

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "import",
);
const bytesOf = (name: string) => readFileSync(path.join(FIXTURES, name));

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * A multipart POST carrying one file.
 *
 * `content-length` is set explicitly because `undici` streams a FormData body and
 * declares no length for it — and the handler refuses an upload that will not say
 * how big it is. Overridable per test, which is how the wire-size cap is driven
 * without allocating 40 MB.
 */
async function upload(
  name: string,
  bytes: Uint8Array,
  options: { mime?: string; declared?: number } = {},
): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name, { type: options.mime ?? XLSX_MIME }));
  // Built once so the boundary in the header matches the body it describes.
  const shaped = new Request("http://localhost/api/import/upload", {
    method: "POST",
    body: form,
  });
  const body = await shaped.arrayBuffer();
  return POST(
    new Request("http://localhost/api/import/upload", {
      method: "POST",
      headers: {
        "content-type": shaped.headers.get("content-type") ?? "",
        "content-length": String(options.declared ?? body.byteLength),
      },
      body,
    }),
  );
}

/** A JSON paste POST. */
function paste(body: string, declared?: number): Promise<Response> {
  return POST(
    new Request("http://localhost/api/import/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(declared ?? Buffer.byteLength(body)),
      },
      body,
    }),
  );
}

let source: FixtureDataSource;

beforeEach(() => {
  cookieJar.clear();
  configuredRef.current = true;
  source = new FixtureDataSource();
  sourceRef.current = source;
});

describe("what the route refuses before it parses anything", () => {
  it("answers 503 when the deployment is not configured", async () => {
    configuredRef.current = false;
    const response = await upload("clean-40.xlsx", bytesOf("clean-40.xlsx"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/not configured/i) });
  });

  it("answers 401 for an expired session — not a redirect the fetch would follow", async () => {
    process.env.HQ_DEMO = "1";
    cookieJar.set("hq_demo_session", "expired");
    try {
      const response = await upload("clean-40.xlsx", bytesOf("clean-40.xlsx"));
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/session expired/i);
    } finally {
      delete process.env.HQ_DEMO;
    }
  });

  it("refuses a declared size over the cap without reading the body", async () => {
    // 40 MB declared, 5 KB sent: if the cap were enforced after the read this
    // would be a successful import of a small file.
    const response = await upload("clean-40.xlsx", bytesOf("clean-40.xlsx"), {
      declared: 40 * 1024 * 1024,
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/40\.0 MB and the limit is 10 MB/);
    // Nothing was created: the refusal is before the store is touched.
    expect(await source.imports()).toHaveLength(0);
  });

  it("refuses a request that declines to say how big it is", async () => {
    // `headers.get()` answers null when the header is absent and `Number(null)`
    // is 0 — finite, non-negative, straight past the cap. So the one request the
    // pre-read check exists for, the chunked one, was the one it waved through
    // while the code above it said otherwise.
    const form = new FormData();
    form.set("file", new File([bytesOf("clean-40.xlsx") as BlobPart], "clean-40.xlsx"));
    const shaped = new Request("http://localhost/api/import/upload", { method: "POST", body: form });
    const body = await shaped.arrayBuffer();
    const response = await POST(
      new Request("http://localhost/api/import/upload", {
        method: "POST",
        headers: { "content-type": shaped.headers.get("content-type") ?? "" },
        body,
      }),
    );
    expect(response.status).toBe(411);
    expect(((await response.json()) as { error: string }).error).toMatch(/did not say how big/i);
    expect(await source.imports()).toHaveLength(0);
  });

  it("refuses an empty content-length rather than reading it as zero", async () => {
    const response = await POST(
      new Request("http://localhost/api/import/upload", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "  " },
        body: JSON.stringify({ paste: "Company\nAcme" }),
      }),
    );
    expect(response.status).toBe(411);
  });

  it("refuses a content-length that is not a number", async () => {
    const response = await POST(
      new Request("http://localhost/api/import/upload", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "banana" },
        body: JSON.stringify({ paste: "Company\nAcme" }),
      }),
    );
    expect(response.status).toBe(411);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/did not say how big it is/i);
  });
});

describe("the magic-byte refusals — by name, never by stack trace", () => {
  it("names an .xls for what it is and says what to do instead", async () => {
    const response = await upload("tracker.xls", bytesOf("fake.xls"), {
      mime: "application/vnd.ms-excel",
    });
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/\.xls\b/);
    expect(body.error).toMatch(/xlsx|Save As|export/i);
  });

  it("refuses an OLE2 file even when it is named .xlsx — the bytes decide", async () => {
    // The whole reason the sniff reads bytes: a rename is one keystroke, and the
    // parser's own exception text tells nobody anything.
    const response = await upload("tracker.xlsx", bytesOf("fake.xls"));
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/\.xls\b/);
  });

  it("names a password-protected workbook", async () => {
    const response = await upload("locked.xlsx", bytesOf("encrypted.xlsx"));
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/password|protected/i);
  });

  it("names an Apple Numbers file", async () => {
    const response = await upload("tracker.numbers", bytesOf("fake.numbers"));
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/numbers/i);
  });

  it("refuses an empty file rather than staging zero rows", async () => {
    const response = await upload("empty.csv", new Uint8Array(0), { mime: "text/csv" });
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/empty/i);
  });
});

describe("the paste path", () => {
  it("stages pasted rows", async () => {
    const response = await paste(
      JSON.stringify({ paste: "Company,Title\nAcme,Product Manager\nGlobex,Senior PM\n" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { batchId: string; rows: number };
    expect(body.rows).toBe(3);
    const found = await source.importBatch(body.batchId);
    expect(found?.batch.sourceKind).toBe("paste");
    expect(found?.batch.filename).toBe("Pasted rows");
    expect(found?.rows).toHaveLength(3);
  });

  it("refuses a body that is not JSON, and one with nothing pasted", async () => {
    const notJson = await paste("Company,Title\nAcme,PM");
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toMatch(/not JSON/i);

    for (const value of ["", "   \n\t ", 42, null]) {
      const empty = await paste(JSON.stringify({ paste: value }));
      expect(empty.status, `accepted ${JSON.stringify(value)}`).toBe(400);
      expect(((await empty.json()) as { error: string }).error).toMatch(/Nothing was pasted/i);
    }
  });

  it("bounds the paste itself, separately from the file cap", async () => {
    // 4 MB, not 10: a paste is a string in memory rather than a streamed file.
    const big = JSON.stringify({ paste: "a,b\n".repeat(1_100_000) });
    const response = await paste(big);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toMatch(/paste is too big/i);
  });

  it("refuses a paste whose every line is blank", async () => {
    const response = await paste(JSON.stringify({ paste: ",,,\n,,,\n \n" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/every line is empty/i);
  });
});

describe("the row cap", () => {
  it("refuses 5,001 rows and says how many it saw", async () => {
    const rows = ["Company,Title"];
    for (let i = 0; i < 5001; i += 1) rows.push(`Company ${i},Product Manager`);
    const response = await paste(JSON.stringify({ paste: rows.join("\n") }));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/5,002 rows and the limit is 5,000/);
    expect(await source.imports()).toHaveLength(0);
  });

  it("drops blank lines — and on the delimited path renumbers what is left", async () => {
    const response = await paste(
      JSON.stringify({ paste: "Company,Title\n\nAcme,PM\n,\nGlobex,Senior PM\n" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { batchId: string; rows: number };
    expect(body.rows).toBe(3);
    const found = await source.importBatch(body.batchId);
    // MEASURED, and it is not what the route's own note describes. Row numbers are
    // assigned over whatever the reader returned, and `readDelimited` parses with
    // papaparse's `skipEmptyLines: "greedy"` — so a blank line is gone before the
    // numbering happens and the rows after it shift up. Gaps survive on the
    // workbook path, where the reader returns the blank rows and the route's own
    // filter is what drops them.
    //
    // Pinned as-is rather than asserted as [1, 3, 5], because a test written to
    // the comment would have failed for the right reason and been "fixed" by
    // deleting it. The consequence is small and real: "row 4" in a report about a
    // pasted file can name line 5 of what the person is looking at.
    expect(found?.rows.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });
});

describe("the happy path, and the retry that must not duplicate it", () => {
  it("parses a real workbook and stages every row verbatim", async () => {
    const response = await upload("clean-40.xlsx", bytesOf("clean-40.xlsx"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { batchId: string; rows: number; idempotencyKey: string };
    expect(body.rows).toBe(41); // 40 data rows plus the header row
    expect(body.idempotencyKey).toBeTruthy();

    const found = await source.importBatch(body.batchId);
    expect(found?.batch.sourceKind).toBe("xlsx");
    expect(found?.batch.filename).toBe("clean-40.xlsx");
    expect(found?.rows).toHaveLength(41);
    // Verbatim, keyed by column index — the browser never parsed anything.
    expect(found?.rows[1]?.raw["0"]).toBe("Kestrel Labs");
    expect(found?.rows[1]?.raw["4"]).toMatch(/^https:\/\/boards\.greenhouse\.io\//);
  });

  it("replays a retried upload onto the batch it already created", async () => {
    const key = "retry-me";
    const bytes = bytesOf("clean-40.xlsx");
    const form = new FormData();
    form.set("file", new File([bytes], "clean-40.xlsx", { type: XLSX_MIME }));
    const shaped = new Request("http://localhost/api/import/upload", { method: "POST", body: form });
    const raw = await shaped.arrayBuffer();
    const post = () =>
      POST(
        new Request("http://localhost/api/import/upload", {
          method: "POST",
          headers: {
            "content-type": shaped.headers.get("content-type") ?? "",
            "content-length": String(raw.byteLength),
            "x-hq-idempotency-key": key,
          },
          body: raw,
        }),
      );

    const first = (await (await post()).json()) as { batchId: string };
    const second = (await (await post()).json()) as { batchId: string };
    expect(second.batchId).toBe(first.batchId);
    expect(await source.imports()).toHaveLength(1);
  });
});

describe("GET", () => {
  it("explains itself rather than answering Next's bare 405", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    const body = (await response.json()) as {
      error: string;
      contract: { limits: { bytes: number; rows: number } };
    };
    expect(body.error).toMatch(/Use POST/);
    expect(body.contract.limits).toEqual({ bytes: 10 * 1024 * 1024, rows: 5000 });
  });
});
