import { safeHref } from "@/lib/url/safe-href";
import { CLOSED_STATUS, type DigestPostingView } from "./store";

/**
 * The six landing states of `/d/<token>`, as standalone HTML.
 *
 * WHO IS LOOKING AT THIS: somebody who tapped a link in a daily email, on a
 * phone, inside a mail client's in-app browser. That is the least capable browser
 * in the fleet and it is not the app — there is no session, no sidebar and no
 * React on the page. So: one document, inline styles, no external stylesheet, and
 * no client JavaScript beyond the form submit the button already is
 * (`docs/plans/PHASE-DIGEST.md` §3.4).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE STYLES ARE `style=` ATTRIBUTES AND NOT A `<style>` BLOCK
 *
 * A `<style>` block would work in every WebView shipping today, and the rule is
 * kept anyway because it costs nothing here and the failure it prevents is one
 * this system cannot see: a page that renders as unstyled text in one person's
 * mail client produces no error, no alert and no bug report — it produces a
 * decision that never got made. Dark mode is handled the same way, without a
 * media query: `<meta name="color-scheme">` plus CSS system colours (`Canvas`,
 * `CanvasText`, `LinkText`), each with a hex fallback declared FIRST so a browser
 * that does not know the keyword still gets a readable page rather than a
 * transparent one.
 *
 * The buttons keep fixed colours in both schemes on purpose: they are the one
 * element whose contrast must not depend on a keyword being understood.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EVERY INTERPOLATION IS ESCAPED, INCLUDING THE ONES THAT "CANNOT" BE HOSTILE
 *
 * `company`, `title` and `location` came off an ATS adapter's JSON, and `url`
 * came off the same place or out of an LLM reading somebody's mail. This file
 * builds a string of HTML by concatenation, which is the construction that turns
 * one unescaped field into script execution — so `esc()` is applied at every
 * interpolation and `safeHref()` at every link. `core/digest_links.py:safe_href`
 * is the same guard on the email side, and its docstring lists what each refusal
 * has cost somebody.
 */

/** Where the app itself lives. Relative, so no origin env var is involved. */
const APP_QUEUE = "/queue";

/** 44x44 is the tap target floor. The button is full width and taller than that. */
const BUTTON =
  "display:block;width:100%;box-sizing:border-box;min-height:48px;padding:14px 18px;" +
  "margin:0;border:0;border-radius:10px;font:600 17px/1.3 -apple-system,BlinkMacSystemFont," +
  "'Segoe UI',Roboto,Helvetica,Arial,sans-serif;text-align:center;cursor:pointer;" +
  "-webkit-appearance:none;appearance:none";
const PRIMARY = `${BUTTON};background:#15503a;color:#ffffff`;
const SECONDARY = `${BUTTON};background:#40464d;color:#ffffff`;
const CARD =
  "max-width:34rem;margin:0 auto;padding:22px;border-radius:14px;" +
  "background:#ffffff;background:Canvas;color:#111111;color:CanvasText;" +
  "border:1px solid #d0d3d6";
const PAGE =
  "margin:0;padding:24px 16px;background:#ffffff;background:Canvas;color:#111111;color:CanvasText;" +
  "font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const H1 = "margin:0 0 12px;font-size:21px;line-height:1.25";
const P = "margin:0 0 16px";
const MUTED = "margin:0 0 16px;color:#5b6167;font-size:15px";
const LINK = "color:#0b4f9e;color:LinkText";

/** `&<>"'` — the five that turn text into markup or break out of an attribute. */
export function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `interested` -> the words a person reads. */
function actionLabel(action: string): string {
  return action === "interested" ? "Interested" : "Not for me";
}

/**
 * The expiry date, in UTC and spelled out.
 *
 * UTC rather than the reader's zone because the page is rendered on a server that
 * does not know the reader's zone and must not guess one. Worst case the named
 * date is a few hours off the one their phone would show, which is a smaller lie
 * than a date computed from the server's own locale.
 */
function niceDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(epochSeconds * 1000));
}

function shell(title: string, inner: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The dark-mode mechanism, in one tag: it tells the browser to render form
    // controls and system colours in the reader's scheme.
    '<meta name="color-scheme" content="light dark">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${esc(title)}</title>`,
    "</head>",
    `<body style="${PAGE}"><main style="${CARD}">`,
    inner,
    "</main></body></html>",
  ].join("\n");
}

/** Company, title and location, plus the posting link when there is a safe one. */
function postingBlock(posting: DigestPostingView): string {
  const where = posting.location ? ` &middot; ${esc(posting.location)}` : "";
  const href = safeHref(posting.url);
  const link = href
    ? `<p style="${MUTED}"><a style="${LINK}" href="${esc(href)}">View the posting</a></p>`
    : "";
  return (
    `<p style="${P}"><strong>${esc(posting.company)}</strong><br>` +
    `${esc(posting.title)}${where}</p>${link}`
  );
}

function form(token: string, label: string, style: string): string {
  // No `action`: the form posts to the URL it was served from, which is the
  // token's own path. Nothing puts the token into the body, and nothing puts it
  // into a query string where a `Referer` header would carry it away.
  const action = token ? ` action="/d/${encodeURIComponent(token)}"` : "";
  return (
    `<form method="post"${action} style="margin:0 0 12px">` +
    `<button type="submit" style="${style}">${esc(label)}</button></form>`
  );
}

function appLink(text: string): string {
  return `<p style="${MUTED}"><a style="${LINK}" href="${APP_QUEUE}">${esc(text)}</a></p>`;
}

export type DigestPage =
  /** GET, signature good, row untriaged, posting open. The one tap that writes. */
  | { kind: "confirm"; posting: DigestPostingView; action: string }
  /** POST applied (or replayed). `undoToken` is absent once the triage is clear. */
  | { kind: "done"; posting: DigestPostingView | null; triage: string; undoToken: string | null }
  /**
   * The row already carries a decision. `offer` is the token to POST if the
   * person wants the other one — the ORIGINAL token when its action differs from
   * what won, a freshly minted undo when it does not.
   */
  | {
      kind: "already";
      posting: DigestPostingView;
      decided: string;
      offer: { token: string; label: string } | null;
    }
  /** Closed board listing, or a posting this user was never gated. Row 41 + 40. */
  | { kind: "gone"; posting: DigestPostingView | null }
  /** Signature good, clock past. Names the posting so the email still had value. */
  | { kind: "expired"; posting: DigestPostingView | null; expiresAt: number }
  /** Forged, retired kid, mangled by a gateway. ONE sentence, always the same. */
  | { kind: "invalid" }
  /**
   * NOT one of the six. This is what a store outage looks like, and it exists
   * because the alternative is an unhandled throw — which Next answers with a
   * blank 500, on the one page row 41 says may never 500.
   */
  | { kind: "trouble" };

/** `[html, httpStatus]`. */
export function renderDigestPage(page: DigestPage): [string, number] {
  switch (page.kind) {
    case "confirm": {
      const heading =
        page.action === "interested"
          ? "Add this to your pipeline?"
          : page.action === "dismissed"
            ? "Hide this one?"
            : "Undo that decision?";
      const label =
        page.action === "interested"
          ? "Yes, I'm interested"
          : page.action === "dismissed"
            ? "Yes, not for me"
            : "Yes, undo it";
      return [
        shell(
          heading,
          `<h1 style="${H1}">${esc(heading)}</h1>` +
            postingBlock(page.posting) +
            form("", label, page.action === "interested" ? PRIMARY : SECONDARY) +
            // The restated company and title above this button are the last
            // chance to notice a misclick, which is the honest half of the extra
            // tap that GET-never-writes costs (PHASE-DIGEST §3.2).
            appLink("Open the app instead"),
        ),
        200,
      ];
    }

    case "done": {
      const what = page.posting
        ? `${page.posting.company} &mdash; ${page.posting.title}`
        : "That posting";
      const line =
        page.triage === "interested"
          ? `Saved. ${what} is in your pipeline.`
          : page.triage === "dismissed"
            ? `Hidden. ${what} will not come back.`
            : `Undone. ${what} is back in your queue.`;
      return [
        shell(
          "Saved",
          `<h1 style="${H1}">${line}</h1>` +
            (page.undoToken ? form(page.undoToken, "Undo", SECONDARY) : "") +
            appLink("Open the app"),
        ),
        200,
      ];
    }

    case "already": {
      const heading = `You already marked this ${actionLabel(page.decided)}.`;
      return [
        shell(
          "Already decided",
          `<h1 style="${H1}">${esc(heading)}</h1>` +
            postingBlock(page.posting) +
            (page.offer ? form(page.offer.token, page.offer.label, SECONDARY) : "") +
            appLink("Open the app"),
        ),
        200,
      ];
    }

    case "gone": {
      // ONE page for "the board closed it" and "this token's user was never gated
      // that posting". Two pages would answer, for anybody holding a link, the
      // question of whether a posting exists at all.
      const named = page.posting
        ? `<p style="${P}">${esc(page.posting.company)} &mdash; ${esc(page.posting.title)}</p>`
        : "";
      return [
        shell(
          "No longer listed",
          `<h1 style="${H1}">That role is no longer listed.</h1>` +
            named +
            `<p style="${MUTED}">Nothing changed. The link was fine; the posting is gone.</p>` +
            appLink("Open the app"),
        ),
        200,
      ];
    }

    case "expired": {
      const named = page.posting
        ? `<p style="${P}"><strong>${esc(page.posting.company)}</strong><br>${esc(page.posting.title)}</p>`
        : "";
      return [
        shell(
          "Link expired",
          `<h1 style="${H1}">This link expired on ${esc(niceDate(page.expiresAt))}.</h1>` +
            // Naming the posting is the whole point of a distinct expired page:
            // three weeks later the email still tells the person what it was
            // about, and the app is one tap away.
            named +
            appLink("Open it in the app"),
        ),
        410,
      ];
    }

    case "invalid":
      // ONE sentence, identical for forged, mangled and signed-with-a-retired-key.
      // Anything more specific is an oracle.
      return [
        shell(
          "Link not valid",
          `<h1 style="${H1}">This link isn&#39;t valid any more.</h1>` + appLink("Open the app"),
        ),
        400,
      ];

    case "trouble":
      return [
        shell(
          "Try again",
          `<h1 style="${H1}">Something went wrong on our side.</h1>` +
            `<p style="${P}">Nothing changed. Try the link again in a minute.</p>` +
            appLink("Open the app"),
        ),
        503,
      ];
  }
}

/** True when the board says this listing is gone. */
export function isClosed(posting: DigestPostingView): boolean {
  return posting.status === CLOSED_STATUS;
}
