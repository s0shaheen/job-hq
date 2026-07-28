/**
 * The one href guard, for every surface that turns a stored URL into a live link.
 *
 * A `job_url` is what an LLM read out of an attacker-writable email body, and a
 * `postings.url` came off an ATS board. Four places render one into an `href`:
 * the digest email (`core/digest_links.py`, the Python twin of this file), the
 * `/d` landing page (`lib/digest/page.ts`), and the pipeline and queue cells
 * (`pipeline-table.tsx`, `triage-card.tsx`). Before this module each had its own
 * guard or none, and the C2 review's M6 was exactly that: `lib/capture/schema.ts`
 * stored `https://evil.com\@good.com` — which a browser resolves to `evil.com`,
 * because it normalises `\` to `/` — while `page.ts` refused it. A guard the
 * store trusts and a guard the renderer trusts that disagree by one backslash is
 * a stored phish waiting for a page that renders it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE DECISION IS PURE STRING WORK, AND NOT `new URL()`
 *
 * `new URL()` and Python's `urlsplit` disagree on the two cases that matter here.
 * `new URL("https://good.com%40evil.example/")` THROWS; `urlsplit` keeps
 * `good.com%40evil.example` as the host. `new URL("https:///nohost")` reads host
 * `nohost`; `urlsplit` reads none. If either parser were the authority, the two
 * languages could not agree, and the guard the store runs would differ from the
 * guard the email runs — which is the whole failure being fixed. So neither
 * parser decides. The authority is `tests/fixtures/safe-href-cases.json`, and
 * `webapp/tests/unit/safe-href.test.ts` and `tests/core/test_safe_href_parity.py`
 * hold both implementations to it byte for byte.
 *
 * THE RULES, each killing a way the host a browser resolves differs from the host
 * a reader sees:
 *
 *   1. trim; empty is empty.
 *   2. no whitespace, control character or BACKSLASH anywhere — `\` is the M6
 *      bypass, and a control char is a header-injection or display trick.
 *   3. `http://` or `https://` only — no `javascript:`, `data:`, `mailto:`, no
 *      bare path, no protocol-relative `//host`.
 *   4. the AUTHORITY (between `://` and the first `/`, `?` or `#`) may not be
 *      empty, may not contain `@` (userinfo, the phish), and may not contain `%`
 *      (an encoded `@` is userinfo in disguise, and no real host carries one).
 *   5. the host — the authority up to any `:port` — must be non-empty.
 *
 * It NEVER repairs. The `www.` -> `https://www.` repair is capture-specific and
 * happens in `lib/capture/schema.ts` BEFORE the value reaches this guard; here the
 * honest answer to a bad URL is `""`, and the caller renders the text with no link.
 *
 * Homograph and IDN hosts (`https://gооgle.com`) pass — that is inherent to
 * trusting ATS data and is not this guard's job to catch; the list is the fence
 * against host confusion, not against a lookalike domain somebody registered.
 */

// Written as ESCAPES, never the literal characters: a control character in a
// source line is unreadable, unreviewable, and one keystroke from a typo nobody
// can see. `\s` covers space, tab and newline; the range is the C0 controls and
// DEL.
const FORBIDDEN_CHARS = /[\s\\\u0000-\u001f\u007f]/;
const SCHEME = /^https?:\/\//i;

export function safeHref(raw: string | null | undefined): string {
  const url = (raw ?? "").trim();
  if (!url) return "";
  if (FORBIDDEN_CHARS.test(url)) return "";
  if (!SCHEME.test(url)) return "";

  const afterScheme = url.slice(url.indexOf("://") + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority === "") return ""; // https:///nohost — no host at all
  if (authority.includes("@") || authority.includes("%")) return ""; // userinfo, encoded or not

  const host = authority.split(":", 1)[0];
  if (host === "") return ""; // https://:8080 — a port with no host

  return url;
}
