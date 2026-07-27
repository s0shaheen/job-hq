/**
 * Which board a row points at, and whether Prepare can read it.
 *
 * Pure. No fetch — `board-source.ts` does that, and this file is what decides
 * whether there is anything to fetch. Two facts go in (the posting key and the
 * posting's URL) and one of four verdicts comes out, each of which the surface
 * renders as a different sentence.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY GREENHOUSE AND ONLY GREENHOUSE
 *
 * `docs/research/ats-apply-mechanics.md`, headline finding 1: Greenhouse is the
 * one ATS family with a KEYLESS JSON question schema. A plain GET of
 *
 *     boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true
 *
 * returns every field with its type, its options and its required flag, before
 * any browser opens and with no account, no key and no cookie. It is 280 of the
 * 648 tracked companies — 43.2%, the largest single family and the whole reason
 * `AUTO-APPLY.md`'s build shape starts here.
 *
 * Ashby, Lever and SmartRecruiters (a further 39.2%) have predictable hosted
 * forms and no such schema: reading one means parsing a page, which is a
 * different piece of work with a different failure mode. Tier C (17.4%) is behind
 * an account wall. None of that is built, and this file's job is to say so per
 * row rather than to let a button fail in an interesting way.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE BOARD TOKEN IS THE PART THAT CAN BE MISSING
 *
 * The API is keyed by the BOARD (the company's token) and the job id. Both are
 * in a `boards.greenhouse.io/{token}/jobs/{id}` URL and only one is in the two
 * other shapes Greenhouse serves — the `embed/job_app?token=` iframe and a
 * company's own careers page carrying `?gh_jid=`. A row stored from one of those
 * is knowably Greenhouse and unfetchable, which is a THIRD state, distinct from
 * "not Greenhouse" and from "the fetch failed".
 */

/** What Prepare can do with one pipeline row. */
export type ApplyTarget =
  /** Greenhouse, board and job both known. The only fetchable case. */
  | { kind: "greenhouse"; boardToken: string; jobId: string }
  /** A known ATS family that Prepare cannot read yet. `ats` is the family. */
  | { kind: "unsupported-ats"; ats: string }
  /** Greenhouse, but the URL names no board. */
  | { kind: "no-board"; jobId: string | null }
  /** Nothing to go on: no posting key, no usable URL. */
  | { kind: "unknown" };

/**
 * The ATS family of a `{ats}-{native_id}` posting key.
 *
 * `core/jobkeys.py` is the authority on the format and `lib/import/job-key.ts`
 * is its TypeScript port; this only reads the prefix, which is why it does not
 * join that golden fixture. A key with no dash has no family.
 */
export function atsOfPostingKey(postingKey: string | null | undefined): string | null {
  const key = (postingKey ?? "").trim().toLowerCase();
  const dash = key.indexOf("-");
  if (dash <= 0) return null;
  return key.slice(0, dash);
}

/**
 * A board token as Greenhouse writes them: lower-case letters, digits, and the
 * three separators seen in real slugs.
 *
 * Anchored and bounded, and it is what makes the fetch URL safe by construction
 * — the API host is a literal in `board-source.ts` and the only interpolated
 * parts are these two, both checked here. Nothing a posting's URL contains can
 * redirect a request somewhere else.
 */
const BOARD_TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const JOB_ID = /^[0-9]{1,20}$/;

export type BoardRef = { boardToken: string; jobId: string };

/** greenhouse.io itself, or a subdomain of it. Never a domain that merely ends in it. */
function isGreenhouseHost(host: string): boolean {
  // The trailing dot of a fully-qualified name is dropped first:
  // `boards.greenhouse.io.` is a real, resolvable spelling of the same host, and
  // refusing it read a Greenhouse posting as somebody else's. A false NEGATIVE
  // only — the row falls to `no-board` — but a wrong answer either way.
  const h = host.endsWith(".") ? host.slice(0, -1) : host;
  return h === "greenhouse.io" || h.endsWith(".greenhouse.io");
}

/**
 * A URL safe to put in an `href`, or `""`.
 *
 * `lib/referral/linkedin.ts`'s `connectionUrl` is the house pattern and its
 * comment names the failure: "a CSV cell is a place a `javascript:` string can
 * live". A Greenhouse payload's `absolute_url` is the same class of value —
 * third-party JSON, rendered as a link — and it reached the DOM unchecked.
 * Executed, what landed:
 *
 *   "javascript:window.__p=1"            -> React 19 neuters it, loudly
 *   "data:text/html,<script>1</script>"  -> VERBATIM
 *   "vbscript:msgbox(1)"                 -> VERBATIM
 *
 * React's own guard covers exactly one scheme. This allows two and refuses
 * everything else, which is the direction that does not need a browser release to
 * stay correct.
 */
export function httpUrlOrEmpty(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // A relative path is not something this app can link to from a server render
    // (there is no base it would mean anything against), so it is not "safe" —
    // it is unusable, and `""` is what the callers already render as no link.
    return "";
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : "";
}

/**
 * Read a board + job out of a Greenhouse posting URL.
 *
 * Returns null when either half is missing — including for the two shapes that
 * carry a job id and no board. Callers distinguish those through
 * `resolveApplyTarget`, which has a state for it.
 */
export function greenhouseRefFromUrl(url: string | null | undefined): BoardRef | null {
  const raw = (url ?? "").trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // `new URL("careers/x")` throws where Python's urlparse answers an empty
  // netloc (matrix row 140's trap, one file over) — handled by the catch above.
  const host = parsed.hostname.toLowerCase();
  // A DOT-anchored suffix, not a bare `endsWith`: "notgreenhouse.io" ends with
  // "greenhouse.io" and is somebody else's domain. It cannot reach the network
  // from here — the API host is a literal — but it would have this app treat a
  // stranger's posting as a Greenhouse one, which is a wrong answer with a
  // confident shape.
  if (!isGreenhouseHost(host)) return null;
  // `/{token}/jobs/{id}` — the only shape carrying both halves. The embed
  // (`/embed/job_app?token=<job id>`) is deliberately not matched: its `token`
  // is the JOB id wearing the board's parameter name, and treating it as a board
  // would build a URL for a board that does not exist.
  const m = /^\/([^/]+)\/jobs\/([0-9]+)/.exec(parsed.pathname);
  if (!m) return null;
  const boardToken = m[1].toLowerCase();
  const jobId = m[2];
  if (!BOARD_TOKEN.test(boardToken) || !JOB_ID.test(jobId)) return null;
  if (boardToken === "embed") return null;
  return { boardToken, jobId };
}

/** The job id alone, from any Greenhouse URL shape. Null when there is none. */
export function greenhouseJobIdFromUrl(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const greenhouse = isGreenhouseHost(host);
  const fromEmbed = parsed.searchParams.get("token") ?? "";
  const fromParam = parsed.searchParams.get("gh_jid") ?? "";
  const fromPath = /\/jobs\/([0-9]+)/.exec(parsed.pathname)?.[1] ?? "";
  const candidate = greenhouse ? fromPath || fromEmbed || fromParam : fromParam;
  return JOB_ID.test(candidate) ? candidate : null;
}

/** The native id half of a `{ats}-{id}` key. */
function nativeIdOfPostingKey(postingKey: string | null | undefined): string | null {
  const key = (postingKey ?? "").trim();
  const dash = key.indexOf("-");
  if (dash <= 0) return null;
  const id = key.slice(dash + 1);
  return JOB_ID.test(id) ? id : null;
}

/**
 * What Prepare can do with this row.
 *
 * The posting KEY decides the family and the URL decides the board, and they are
 * read in that order on purpose: the key is this system's own identifier, minted
 * by the sweep from the source it fetched, while a URL is whatever a board
 * redirected to. A row with a Greenhouse key and a company-domain URL is
 * Greenhouse.
 */
export function resolveApplyTarget(input: {
  postingKey?: string | null;
  url?: string | null;
}): ApplyTarget {
  const ats = atsOfPostingKey(input.postingKey);
  const ref = greenhouseRefFromUrl(input.url);

  if (ats !== null && ats !== "greenhouse") {
    // A row from another family. Named, because "we do not support Ashby yet" is
    // a different sentence from "we could not read this".
    return { kind: "unsupported-ats", ats };
  }
  if (ref) return { kind: "greenhouse", ...ref };
  if (ats === "greenhouse") {
    return { kind: "no-board", jobId: nativeIdOfPostingKey(input.postingKey) };
  }
  // No key at all: an application somebody typed in, or one imported from a
  // spreadsheet. There is nothing here to identify a board with.
  const jobId = greenhouseJobIdFromUrl(input.url);
  if (jobId !== null) return { kind: "no-board", jobId };
  return { kind: "unknown" };
}

/** The keyless question-schema endpoint. The host is a literal; both parts are checked. */
export function greenhouseFormUrl(ref: BoardRef): string {
  if (!BOARD_TOKEN.test(ref.boardToken) || !JOB_ID.test(ref.jobId)) {
    throw new Error("greenhouse: refusing to build a URL from an unchecked ref");
  }
  return `https://boards-api.greenhouse.io/v1/boards/${ref.boardToken}/jobs/${ref.jobId}?questions=true`;
}
