"""The one identity job-hq declares on every outbound request it makes on its
own behalf.

WHY THIS EXISTS AS A CONSTANT AND NOT A HABIT. Eight of the nine discovery
fetchers used to send `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) …
Chrome/126.0 Safari/537.36` from Lambda. Nothing about that string was true:
no Macintosh, no Chrome, no person at a keyboard. A server that calls itself a
desktop browser is asking to be scored as a human, which is the definition of
the "covert anti-bot evasion" CLAUDE.md forbids without qualification — and it
makes any "we honor robots.txt" claim unverifiable, because a robots file that
discriminates by agent (Lever's does) cannot discriminate against a name we
refuse to give. The remaining five sent `python-requests/2.32.3`, which is not
a lie but is not an identity either: it names a library, not a product, and
gives an operator no route to reach us.

WHAT THE SHAPE IS COPIED FROM. `monitor/scripts/ingest_edgar.py` and
`ingest_formadv.py` have carried a real contact string since they were written,
because SEC fair-access returns 403 to anything else. That is the precedent:
product name, version, a page, and a way to reach a human. This string
satisfies the SEC rule too, so a future fair-access endpoint needs no exception.
`webapp/lib/quickadd/fetch.ts` already declares the browser-side sibling of
this identity on the same domain; the two are deliberately the same claim.

CONTACT IS A PROMISE, NOT DECORATION — AND IT IS NOT YET KEPT. `job-hq.app`
does not resolve today and `bots@job-hq.app` does not receive mail today. The
address is a ROLE address on purpose: the two SEC ingest scripts still carry
the owner's personal gmail, which issue #184 (vault split) says does not belong
in the product repo, and copying it onto fourteen more endpoints would have
spread the thing that issue is trying to remove. So this ships as the correct
identity that the owner must MAKE real — register the domain, land the mailbox
— and the two ingest scripts follow once it answers. Until then this names a
product truthfully and points at an address that is ours; the failure mode is a
contact route that bounces, which is a smaller lie than a browser that does not
exist, and one the owner can close without another code change.

DO NOT make this configurable. An env- or config-sourced agent is how a
spoof comes back: it moves the string somewhere `tests/monitor/test_fetcher_
useragent.py` cannot sweep, which is exactly the attack that test is written
against. One constant, one home, imported.
"""
from __future__ import annotations

PRODUCT = "job-hq"
VERSION = "1.0"
HOMEPAGE = "https://job-hq.app"
# Role address, not a person: see the module docstring. The owner must make
# this deliverable; nothing here verifies that it is.
CONTACT = "bots@job-hq.app"

#: Sent as `User-Agent` on every outbound request job-hq makes for itself.
USER_AGENT = f"{PRODUCT}/{VERSION} (+{HOMEPAGE}; {CONTACT})"
