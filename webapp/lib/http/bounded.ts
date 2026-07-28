import "server-only";

/**
 * Read a body chunk by chunk, cancelled the moment it goes past a cap.
 *
 * Extracted from `lib/apply/board-source.ts`, which learned this the expensive
 * way (matrix row 265): its cap gated on the DECLARED `content-length` and then
 * called `res.json()`. A chunked body declares nothing, `Number(null ?? "0")` is
 * 0 and `Number("abc")` is NaN, so a 20 MB payload was read in full into a
 * server-side allocation. **A cap that only works when the other end is honest
 * about its size is not a cap.**
 *
 * ONE IMPLEMENTATION, not two, and that is the reason this file exists rather
 * than a second copy inside `lib/capture/`. `Request` and `Response` both carry a
 * `ReadableStream` on `.body`, so the outbound half (a job board's answer) and
 * the inbound half (an Apps Script's POST) are the same operation on the same
 * type. Two copies of a guard is two chances for one of them to be relaxed by
 * somebody who only read the other.
 *
 * `arrayBuffer()` would be shorter and allocates the whole thing before anything
 * can check its size, which is the bug this replaces.
 */

export type BoundedRead =
  /** The complete body, under the cap. */
  | { ok: true; text: string }
  /**
   * `too-large` and `no-body` are kept apart because they are different
   * sentences: a runtime that hands back no stream is not a caller sending
   * 20 MB, and telling somebody their small request was too big is a support
   * conversation nobody can win.
   */
  | { ok: false; why: "too-large" | "no-body" };

export async function readBoundedBody(
  source: { body: ReadableStream<Uint8Array> | null },
  max: number,
): Promise<BoundedRead> {
  const body = source.body;
  if (!body) return { ok: false, why: "no-body" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return { ok: false, why: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

/**
 * The declared length, as a CLAIM rather than a measurement.
 *
 * Worth checking only because it is free: an honest caller announcing 40 MB is
 * refused before a single byte is read. It answers `false` for an absent or
 * unparseable header — those are not "small", they are "unstated", and the
 * streaming read above is what covers them.
 */
export function declaresOverCap(headers: Headers, max: number): boolean {
  const raw = headers.get("content-length");
  if (raw === null) return false;
  const declared = Number(raw.trim() || "x");
  return Number.isFinite(declared) && declared > max;
}
