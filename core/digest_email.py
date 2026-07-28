"""The digest email — composed here, from the same data that builds the Digest row.

`tracker/digest.py` gathers the day's picture once into a `DigestData` and then
renders it twice: as the markdown body that goes into the Digest tab (unchanged
from the sheet era) and, here, as the HTML + text/plain email the engine sends.
One gather, two renders, so the email can never disagree with the row.

WHY THE APPS SCRIPT COMPOSER HAD TO GO, and not just move: `Code.gs`'s
`markdownLiteToHtml_` handles `#`, `##`, `- ` and `**bold**` and has **no link
handling at all** — no `href` appears anywhere in that file. Today's digest rows
carry `- [Acme — Product Manager](https://…)` per role, so the mailed HTML shows
literal brackets and parentheses (matrix row 42). One-click action links were
never a small addition to it.

THE HTML RULES, each one a failure somebody has shipped:

* **Tables for layout, inline styles only, no `<style>` block.** Outlook renders
  with Word's engine: no flex, no grid, and a stylesheet it may drop entirely.
* **Explicit background AND color on every container.** A dark-mode client that
  finds one unset inverts the container and leaves the text, which is how a
  digest becomes white-on-white.
* **Under 90 KB.** Gmail clips at roughly 102 KB and clips from the BOTTOM, so
  the first thing lost is the footer and the last roles. The cap is enforced by
  dropping roles and saying how many, never by truncating markup.
* **Tap targets.** Each action link is a padded block with a minimum height, and
  the pair is separated, because the two buttons are opposites and a mis-tap on
  a phone is a dismissal the reader has to go undo.
* **Every href is checked.** `core.digest_links.safe_href` refuses anything that
  is not absolute http(s) with no userinfo. Posting URLs come from ATS adapters
  and, on the capture path, from an LLM reading an untrusted email body — the C2
  review filed that as P-2 against exactly this renderer.

VOICE. This is the one piece of user-facing prose the engine writes. It reads
like a terse status line, not like a newsletter: no greeting, no sign-off, no
"here's your daily digest", no exclamation marks. Counts and nouns.
"""
from __future__ import annotations

import datetime as _dt
import html
from dataclasses import dataclass, field

from core import digest_links

#: Gmail clips around 102 KB and clips the END of the document. 90 KB leaves
#: room for the transport encoding and for a long health section.
MAX_HTML_BYTES = 90_000

BG = "#f4f4f5"          # page
CARD = "#ffffff"        # the one column
INK = "#111827"         # body text
MUTED = "#4b5563"       # secondary text, 7.5:1 on white
RULE = "#e4e4e7"
ACCENT = "#1d4ed8"      # links and the primary button, 7.0:1 both ways
BTN_EDGE = "#d1d5db"
BTN_INK = "#374151"

#: Every digest says how to stop it. There is no `List-Unsubscribe` header and
#: no unsubscribe route yet (PHASE-DIGEST increment 6), and the honest
#: substitute in a system whose settings are a phone-editable spreadsheet is to
#: name the cell. An email with no way off it is spam, whoever sent it.
FOOTER = ("Sent by the HQ digest job. Replies go nowhere. To stop it, set "
          "notify_digest to push or none in the Config tab.")


@dataclass(frozen=True)
class Role:
    """One row of the New roles section, structured rather than pre-formatted."""
    key: str
    company: str
    title: str
    url: str = ""
    location: str = ""
    note: str = ""            # why an off-profile row is here at all
    priority: bool = False


@dataclass(frozen=True)
class DigestData:
    """Everything both renderers need, and nothing either of them re-derives."""
    date: str
    roles: list[Role] = field(default_factory=list)
    roles_total: int = 0
    changes: list[str] = field(default_factory=list)
    review: list[str] = field(default_factory=list)
    review_total: int = 0
    followups: list[str] = field(default_factory=list)
    followups_total: int = 0
    scout: list[str] = field(default_factory=list)
    health: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Email:
    subject: str
    html: str
    text: str


def _e(s: str) -> str:
    return html.escape(str(s or ""), quote=True)


def _pretty_date(iso: str) -> str:
    try:
        return _dt.date.fromisoformat(iso).strftime("%a %-d %b")
    except ValueError:
        return iso


def subject_for(data: DigestData) -> str:
    """Date first so Gmail does not thread a week of digests into one row, then
    the two numbers that decide whether this one is worth opening."""
    bits = []
    if data.roles_total:
        bits.append(f"{data.roles_total} new role{'s' if data.roles_total != 1 else ''}")
    if data.changes:
        bits.append(f"{len(data.changes)} update{'s' if len(data.changes) != 1 else ''}")
    if data.review_total:
        bits.append(f"{data.review_total} to review")
    tail = ", ".join(bits) if bits else "nothing new"
    return f"Job Search HQ — {_pretty_date(data.date)}: {tail}"


# ------------------------------------------------------------------ links

@dataclass(frozen=True)
class RoleLinks:
    interested: str = ""
    dismissed: str = ""


def _links_for(role: Role, *, base: str, user_id: str, keys, now) -> RoleLinks:
    # No key, no links — NOT an error. A Feed row can reach the digest with a
    # blank `key` cell (a partial write, a hand-edited row), and `mint` refuses a
    # blank posting key with a ValueError. Raising here would take the whole
    # briefing down with the email: the ntfy push, the Gmail-capture-silent and
    # backups-stale watchdogs, and both heartbeats all live after the compose
    # call in `tracker.digest`. That is the exact "one row blinds every watchdog"
    # failure the pg-beats read was walked back for (C3 review M3). The role
    # still renders, with its posting link, minus the two action buttons.
    if not base or not user_id or not keys or not role.key:
        return RoleLinks()
    return RoleLinks(
        interested=digest_links.action_url(base, digest_links.mint(
            user_id, role.key, "interested", now=now, keys=keys)),
        dismissed=digest_links.action_url(base, digest_links.mint(
            user_id, role.key, "dismissed", now=now, keys=keys)),
    )


# ------------------------------------------------------------------- HTML

def _btn(href: str, label: str, *, primary: bool) -> str:
    """A tap target, not a text link: 44px is the smallest thing a thumb hits
    reliably, and the pair sits in separate table cells with a gutter between
    them because the two answers are opposites."""
    bg, fg, edge = (ACCENT, "#ffffff", ACCENT) if primary else (CARD, BTN_INK, BTN_EDGE)
    return (f'<a href="{_e(href)}" style="display:block;min-height:44px;'
            f'line-height:24px;padding:10px 16px;background:{bg};color:{fg};'
            f'border:1px solid {edge};border-radius:6px;text-align:center;'
            f'text-decoration:none;font-weight:600;font-size:15px;">{_e(label)}</a>')


def _role_block(role: Role, links: RoleLinks) -> str:
    star = "&#9733; " if role.priority else ""
    url = digest_links.safe_href(role.url)
    title = f"{_e(role.company)} &mdash; {_e(role.title)}"
    head = (f'<a href="{_e(url)}" style="color:{ACCENT};text-decoration:none;'
            f'font-weight:600;">{title}</a>') if url else f"<strong>{title}</strong>"
    meta = " &middot; ".join(_e(x) for x in (role.location, role.note) if x)
    rows = [f'<tr><td style="padding:0 0 4px 0;font-size:16px;color:{INK};">'
            f'{star}{head}</td></tr>']
    if meta:
        rows.append(f'<tr><td style="padding:0 0 8px 0;font-size:13px;'
                    f'color:{MUTED};">{meta}</td></tr>')
    if links.interested and links.dismissed:
        rows.append(
            '<tr><td style="padding:4px 0 0 0;">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
            'width="100%"><tr>'
            f'<td width="50%" style="padding:0 6px 0 0;">'
            f'{_btn(links.interested, "Interested", primary=True)}</td>'
            f'<td width="50%" style="padding:0 0 0 6px;">'
            f'{_btn(links.dismissed, "Not for me", primary=False)}</td>'
            "</tr></table></td></tr>")
    return (f'<tr><td style="padding:12px 0;border-bottom:1px solid {RULE};">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
            f'width="100%">{"".join(rows)}</table></td></tr>')


def _section(title: str, inner: str) -> str:
    if not inner:
        return ""
    return (f'<tr><td style="padding:20px 0 4px 0;font-size:13px;font-weight:700;'
            f'letter-spacing:.06em;text-transform:uppercase;color:{MUTED};">'
            f"{_e(title)}</td></tr>"
            '<tr><td style="padding:0;"><table role="presentation" cellpadding="0" '
            f'cellspacing="0" border="0" width="100%">{inner}</table></td></tr>')


def _bullets(lines: list[str]) -> str:
    return "".join(
        f'<tr><td style="padding:4px 0;font-size:14px;line-height:20px;color:{INK};">'
        f"{_e(line)}</td></tr>" for line in lines)


def _render_html(data: DigestData, roles: list[tuple[Role, RoleLinks]],
                 *, dropped: int, base: str, note: str) -> str:
    blocks = "".join(_role_block(r, l) for r, l in roles)
    extra = data.roles_total - len(roles)
    if extra > 0:
        where = "in the app" if base else "in the Feed tab"
        blocks += (f'<tr><td style="padding:12px 0;font-size:14px;color:{MUTED};">'
                   f"+{extra} more {where}"
                   f"{' (this email was trimmed to fit)' if dropped else ''}</td></tr>")
    body = "".join([
        _section("New roles (last 24h)", blocks),
        _section("Status changes", _bullets(data.changes)),
        _section("Needs review", _bullets(_review_lines(data))),
        _section("Follow-ups", _bullets(_followup_lines(data))),
        _section("Scout yesterday", _bullets(data.scout)),
        _section("Automation health", _bullets(data.health)),
    ])
    footer = (f"{_e(note)}<br>{_e(FOOTER)}" if note else _e(FOOTER))
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light dark">'
        f"<title>{_e(subject_for(data))}</title></head>"
        f'<body style="margin:0;padding:0;background:{BG};color:{INK};">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        f'width="100%" style="background:{BG};color:{INK};"><tr><td align="center" '
        'style="padding:16px 8px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        f'width="100%" style="max-width:600px;background:{CARD};color:{INK};'
        f'border:1px solid {RULE};border-radius:8px;">'
        '<tr><td style="padding:20px 20px 0 20px;font-family:-apple-system,'
        'Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'width="100%">'
        f'<tr><td style="font-size:18px;font-weight:700;color:{INK};">'
        f"Job Search HQ</td></tr>"
        f'<tr><td style="padding:2px 0 0 0;font-size:13px;color:{MUTED};">'
        f"{_e(data.date)}</td></tr>"
        f"{body}</table></td></tr>"
        f'<tr><td style="padding:16px 20px 20px 20px;font-size:12px;color:{MUTED};'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        f"{footer}</td></tr>"
        "</table></td></tr></table></body></html>")


# ------------------------------------------------------------------- text

def _review_lines(data: DigestData) -> list[str]:
    if not data.review_total:
        return []
    lines = [f"{data.review_total} email event(s) need a human match:"] + list(data.review)
    if data.review_total > len(data.review):
        lines.append(f"+{data.review_total - len(data.review)} more in Email Events")
    return lines


def _followup_lines(data: DigestData) -> list[str]:
    lines = list(data.followups)
    if data.followups_total > len(data.followups):
        lines.append(f"+{data.followups_total - len(data.followups)} more stale rows in Pipeline")
    return lines


def _render_text(data: DigestData, roles: list[tuple[Role, RoleLinks]],
                 *, base: str, note: str) -> str:
    """The plain part is not a fallback nobody reads: screen readers, plain-text
    clients and every spam filter read it, and a message with no text/plain
    alternative is the most reliable way into a spam folder."""
    out = [f"Job Search HQ — {data.date}", ""]
    if roles or data.roles_total:
        out.append("NEW ROLES (last 24h)")
        for role, links in roles:
            star = "* " if role.priority else "  "
            out.append(f"{star}{role.company} — {role.title}")
            meta = " · ".join(x for x in (role.location, role.note) if x)
            if meta:
                out.append(f"    {meta}")
            url = digest_links.safe_href(role.url)
            if url:
                out.append(f"    {url}")
            if links.interested:
                out.append(f"    Interested: {links.interested}")
                out.append(f"    Not for me: {links.dismissed}")
        extra = data.roles_total - len(roles)
        if extra > 0:
            out.append(f"  +{extra} more {'in the app' if base else 'in the Feed tab'}")
        out.append("")
    for title, lines in [("STATUS CHANGES", data.changes),
                         ("NEEDS REVIEW", _review_lines(data)),
                         ("FOLLOW-UPS", _followup_lines(data)),
                         ("SCOUT YESTERDAY", data.scout),
                         ("AUTOMATION HEALTH", data.health)]:
        if lines:
            out.append(title)
            out += [f"  {line}" for line in lines]
            out.append("")
    if note:
        out.append(note)
    out.append(FOOTER)
    return "\n".join(out)


# ------------------------------------------------------------------ compose

def compose(data: DigestData, *, user_id: str = "", base_url: str | None = None,
            keys: list[tuple[str, str]] | None = None,
            now: _dt.datetime | None = None) -> Email:
    """`DigestData` -> one email. Pure: no clock of its own beyond `now`, no
    environment read the caller cannot override, no I/O.

    Links are ALL-OR-NOTHING per digest. Without an https origin
    (`HQ_WEBAPP_URL`), a signing key (`HQ_DIGEST_KEYS`) or a pg user id, every
    action link is omitted and the footer says which piece is missing. A relative
    href, a `localhost` link or a link signed with no key would each be a live
    button in a real inbox that does nothing or, worse, something.
    """
    base = digest_links.webapp_base(base_url)
    if keys is None:
        keys = digest_links.load_keys() if digest_links.has_keys() else []

    missing = []
    if not base:
        missing.append("HQ_WEBAPP_URL")
    if not keys:
        missing.append("HQ_DIGEST_KEYS")
    if not user_id:
        missing.append("a pg user id")
    note = (f"One-click links are off: {', '.join(missing)} not set. "
            "Everything below is still current." if missing else "")

    shown = list(data.roles)
    dropped = 0
    while True:
        pairs = [(r, _links_for(r, base=base, user_id=user_id, keys=keys, now=now))
                 for r in shown]
        body = _render_html(data, pairs, dropped=dropped, base=base, note=note)
        if len(body.encode("utf-8")) <= MAX_HTML_BYTES or not shown:
            break
        # Drop from the END, which is the least interesting role (the section is
        # sorted priority-first). Gmail would otherwise clip the same rows AND
        # the footer, without saying it did.
        shown = shown[:-1]
        dropped += 1
    return Email(subject=subject_for(data), html=body,
                 text=_render_text(data, pairs, base=base, note=note))
