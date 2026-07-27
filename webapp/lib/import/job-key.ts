/**
 * Canonical job keys, in TypeScript — a direct port of `core/jobkeys.py`.
 *
 * A key identifies one posting across every funnel (monitor, scout, Gmail
 * evidence, manual paste, and now Import). Import needs it in the browser tier
 * because dedup preview has to say "you already have this" before anything is
 * written, and the engine needs it in Python because that is where discovery
 * runs. Two implementations of one identity function is a liability we accept
 * deliberately, and then guard.
 *
 * **The bug this file exists to not have:** a key that differs from the
 * Python's by one character makes every re-import a silent duplicate. Nothing
 * errors. The user sees two rows for the same job, six weeks later, and no
 * amount of reading either implementation tells them which side is wrong. So
 * the two sides are pinned to one recorded corpus:
 *
 *   `tests/fixtures/jobkeys.golden.json` — 84 cases, generated FROM
 *   `core/jobkeys.py`, asserted by `tests/core/test_jobkeys_golden.py` (Python)
 *   and `webapp/tests/unit/job-key.test.ts` (this port). Edit one side without
 *   the other and exactly one language goes red. That is matrix row 29, and the
 *   reason this module is a transcription rather than a rewrite: it is easier to
 *   diff against the Python when it looks like the Python.
 *
 * ## Where JavaScript is not Python, and what was done about it
 *
 * 1. **`urlparse` vs `new URL`.** `new URL("careers/foo/bar")` THROWS; Python
 *    returns `netloc=""`, `path="careers/foo/bar"`, and the `url-` fallback
 *    keys on exactly that. A pasted relative link is a real input, so the
 *    fallback below is a hand-rolled port of `urllib.parse.urlsplit` +
 *    `_splitparams` — the `\t\r\n` deletion, the C0-control-or-space trim, the
 *    scheme rule, `//`-only netloc, and the `;params` split off the last path
 *    segment. `new URL` is never used here and must never be introduced.
 * 2. **`str.strip()` vs `trim()` trim different characters.** Python strips
 *    U+001C–U+001F and U+0085 and leaves U+FEFF; JS does the exact opposite on
 *    those five codepoints. That is visible in the key — a BOM-prefixed URL
 *    keys as `url-<BOM>https://…` in Python, because the BOM survives to become
 *    part of the path — so the class is spelled out in `PY_WHITESPACE` and
 *    `pyStrip` is used everywhere `.strip()` appears in the Python. Two golden
 *    cases pin both directions.
 * 3. **`\d` is Unicode in Python, ASCII in JS.** `re.compile(r"(\d+)")` matches
 *    Arabic-Indic and Devanagari digits in Python; `/(\d+)/` does not. Same for
 *    `[A-Z]` under `re.I`, which Python folds against U+017F/U+212A. This is a
 *    known, bounded divergence, NOT fixed: an ATS requisition id with non-ASCII
 *    digits does not exist, matching them here would mint a key the engine can
 *    never reproduce, and the golden corpus is deliberately all-ASCII so the
 *    divergence is never exercised on either side. Same class of thing: `.` in
 *    JS also excludes `\r`/U+2028/U+2029, which Python's `.` matches, and `$`
 *    in Python matches before a trailing newline — unreachable here, since
 *    `jobKey` strips the URL before any pattern sees it.
 * 4. **Slicing.** `co[:32]` counts codepoints, `.slice(0, 32)` counts UTF-16
 *    units. `normToken` output is `[a-z0-9-]` only, so they cannot disagree.
 */

/** The UUID shape lever and ashby both use, kept as one string exactly as `_UUID` is. */
const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * `(ats, regex-with-one-capture)` — first match wins, applied to the full URL.
 *
 * Transcribed from `_PATTERNS` in `core/jobkeys.py`, in order, including the
 * order-dependent tail: `sfsf` is LAST because it matches a URL *shape*
 * (`/job/<slug>/<9+ digits>`) rather than an ATS host, so it must only fire
 * when nothing specific did. Reordering this array changes which key a URL
 * gets — `job-key.test.ts` compares the token sequence against the Python's.
 *
 * Exported so the test can compare it to the Python rather than trusting a
 * comment. Nothing else should read it.
 */
export const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["greenhouse", /greenhouse\.io\/(?:embed\/job_app\?.*token=|[^\/]+\/jobs\/)(\d+)/],
  ["greenhouse", /[?&]gh_jid=(\d+)/],
  ["lever", new RegExp(`jobs(?:\\.eu)?\\.lever\\.co/[^/]+/(${UUID})`)],
  ["ashby", new RegExp(`jobs\\.ashbyhq\\.com/[^/]+/(${UUID})`)],
  // token "smartrec" matches the fetcher/seed-csv ats value (system-wide id vocabulary)
  ["smartrec", /jobs\.smartrecruiters\.com\/[^\/]+\/(\d{6,})/],
  // (?:-\d+)? swallows posting-variant suffixes (Adobe _R168260-1); REF\d+W = Visa-style ids.
  // The ONLY case-insensitive pattern — `re.I` in the Python is on this entry alone.
  [
    "workday",
    /myworkdayjobs\.com\/.*[_\/-](JR[-_]?\d+|R-?\d{4,}|REQ[-_]?\d{3,}|REF\d{4,}[A-Z]?)(?:-\d+)?(?:[\/?#]|$)/i,
  ],
  ["amazon", /amazon\.jobs\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d{5,})/],
  ["oraclehcm", /oraclecloud\.com\/.*\/job\/(\d+)/],
  ["google", /google\.com\/about\/careers\/applications\/jobs\/results\/(\d{9,})/],
  ["apple", /jobs\.apple\.com\/[a-z-]+\/details\/(\d{6,})/],
  ["goldman", /higher\.gs\.com\/roles\/(\d+)/],
  ["radancy", /jobs\.intuit\.com\/job\/(?:[^\/]+\/)+(\d{6,})(?:[\/?#]|$)/],
  ["eightfold", /eightfold\.ai\/careers.*[?&]pid=(\d{10,})/],
  [
    "eightfold",
    /(?:explore\.jobs\.netflix\.net|apply\.careers\.microsoft\.com)\/careers.*[?&]pid=(\d{10,})/,
  ],
  ["eightfold", /(?:eightfold\.ai|jobs\.netflix\.net)\/careers\/job\/(\d{10,})/],
  // Two capture groups — the tenant AND the numeric id. The only entry whose key
  // is not `{ats}-{group1}`; dropping the second group collapses every icims
  // posting across every tenant onto colliding keys.
  ["icims", /careers?[-.]([a-z0-9]+)\.icims\.com\/jobs\/(\d+)/],
  // SAP SuccessFactors Career-Site-Builder / jobs2web: the careers host is the
  // company's own vanity domain (no ATS signal), so match the URL shape.
  ["sfsf", /\/job\/[^\/]+\/(\d{9,})(?:[\/?#]|$)/],
] as const;

/**
 * Exactly the codepoints `str.isspace()` is true for — the set Python's
 * argument-less `.strip()` removes.
 *
 * Spelled out rather than delegated to `trim()` or `\s`, because all three sets
 * differ and the difference reaches the key: JS `trim()` also removes U+FEFF
 * (Python keeps it, so a BOM'd URL parses as a path, not a host) and does NOT
 * remove U+001C–U+001F or U+0085 (Python does, so those URLs parse normally).
 */
const PY_WHITESPACE =
  "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const PY_STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, "g");

/** Python's `str.strip()`, not JS's `trim()`. See `PY_WHITESPACE`. */
function pyStrip(s: string): string {
  return s.replace(PY_STRIP, "");
}

/**
 * `_norm_token` — lowercase, `&` to " and ", everything else to hyphens.
 *
 * Order is load-bearing and matches the Python exactly: lower and strip FIRST,
 * then the `&` expansion, then the punctuation squash. Expanding `&` before
 * lowercasing would be harmless; doing the truncation before the expansion
 * would not be — "A&B Consolidated Widget Holdings" grows to 36 characters and
 * the 32-char cut lands mid-word, which is what the golden pins.
 */
function normToken(s: string | null | undefined): string {
  let t = pyStrip((s ?? "").toLowerCase());
  t = t.replace(/&/g, " and ");
  t = t.replace(/[^a-z0-9]+/g, " ");
  // Only ASCII spaces survive the line above, so `\s+` and Python's `\s+` see
  // the same thing despite matching different sets in general.
  return pyStrip(t).replace(/\s+/g, "-");
}

/** Schemes `urlparse` splits `;params` off the path for — `urllib.parse.uses_params`. */
const USES_PARAMS = new Set([
  "",
  "ftp",
  "hdl",
  "prospero",
  "http",
  "imap",
  "https",
  "shttp",
  "rtsp",
  "rtsps",
  "rtspu",
  "sip",
  "sips",
  "mms",
  "sftp",
  "tel",
]);

/** `urllib.parse.scheme_chars`. */
const SCHEME_CHARS = /^[a-zA-Z0-9+\-.]+$/;

/** C0 controls and space — `urlsplit`'s own trim, which is NOT `str.strip()`'s set. */
const C0_OR_SPACE_LEAD = /^[\u0000-\u0020]+/;
const C0_OR_SPACE_TRAIL = /[\u0000-\u0020]+$/;

/** `urllib.parse._splitparams`, path half only. */
function splitParams(path: string): string {
  if (path.includes("/")) {
    const i = path.indexOf(";", path.lastIndexOf("/"));
    return i < 0 ? path : path.slice(0, i);
  }
  const i = path.indexOf(";");
  return i < 0 ? path : path.slice(0, i);
}

/**
 * The `netloc` and `path` of `urlparse(u)` — the two fields the `url-` fallback
 * concatenates — without `new URL`.
 *
 * `new URL` cannot stand in here for three separate reasons, any one of which
 * would be enough: it throws on a relative URL (which humans paste constantly),
 * it lowercases and punycodes the host, and it percent-encodes the path. Python
 * does none of those, so every one of them would produce a key the engine never
 * writes. This is the subset CPython actually implements, ported step for step.
 */
function urlNetlocAndPath(url: string): { netloc: string; path: string } {
  // `_UNSAFE_URL_BYTES_TO_REMOVE` — deleted anywhere in the string, not trimmed.
  let u = url.replace(/[\t\r\n]/g, "");
  // `.strip(_WHATWG_C0_CONTROL_OR_SPACE)` — chr(0) through chr(0x20).
  u = u.replace(C0_OR_SPACE_LEAD, "").replace(C0_OR_SPACE_TRAIL, "");

  let scheme = "";
  const colon = u.indexOf(":");
  if (colon > 0 && /^[A-Za-z]$/.test(u[0]) && SCHEME_CHARS.test(u.slice(0, colon))) {
    scheme = u.slice(0, colon).toLowerCase();
    u = u.slice(colon + 1);
  }

  let netloc = "";
  if (u.slice(0, 2) === "//") {
    // `_splitnetloc`: the netloc ends at the first of `/`, `?`, `#` — a URL with
    // no path at all therefore has an empty path, not a "/".
    let delim = u.length;
    for (const c of "/?#") {
      const at = u.indexOf(c, 2);
      if (at >= 0) delim = Math.min(delim, at);
    }
    netloc = u.slice(2, delim);
    u = u.slice(delim);
  }

  const hash = u.indexOf("#");
  if (hash >= 0) u = u.slice(0, hash);
  const question = u.indexOf("?");
  if (question >= 0) u = u.slice(0, question);
  if (USES_PARAMS.has(scheme) && u.includes(";")) u = splitParams(u);

  return { netloc, path: u };
}

export interface JobKeyInput {
  url?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
}

/**
 * The canonical key for a posting — ATS-derived when possible, a normalized
 * composite otherwise, and `""` only when there is nothing at all to key on.
 *
 * The empty return is not a failure signal to swallow: `job_key("", "", "", "")`
 * is empty in Python too, and callers are expected to treat a keyless row as
 * unkeyable (`match_kind = 'unkeyable'`) rather than to invent something.
 */
export function jobKey(input: JobKeyInput = {}): string {
  const u = pyStrip(input.url ?? "");
  if (u) {
    for (const [ats, pattern] of PATTERNS) {
      const m = pattern.exec(u);
      if (m) {
        if (ats === "icims") return `icims-${m[1]}-${m[2]}`;
        return `${ats}-${m[1]}`;
      }
    }
  }

  const co = normToken(input.company);
  const ti = normToken(input.title);
  if (co && ti) {
    const city = normToken((input.location ?? "").split(",")[0]).slice(0, 24);
    return `norm-${co.slice(0, 32)}|${ti.slice(0, 48)}|${city}`;
  }

  if (u) {
    // last resort: the URL itself, stripped of query noise
    const { netloc, path } = urlNetlocAndPath(u);
    return `url-${netloc}${path}`.replace(/\/+$/, "");
  }
  return "";
}

/** The ATS family a key came from — everything before the first hyphen. */
export function atsOf(key: string | null | undefined): string {
  return (key ?? "").split("-", 1)[0] ?? "";
}

/**
 * ATS-derived keys are strong (safe to auto-merge on); `norm-`/`url-` keys are
 * weak — matching on them stays a suggestion, not a hard merge.
 *
 * This is the ONLY thing allowed to authorize a merge during import. A weak key
 * is a guess about two rows being the same job; merging on a guess destroys the
 * row that loses, and nothing in the app can put it back.
 */
export function isStrong(key: string | null | undefined): boolean {
  const k = key ?? "";
  return Boolean(k) && !k.startsWith("norm-") && !k.startsWith("url-");
}
