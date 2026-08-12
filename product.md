# Job HQ — what this product is

Job HQ turns a job search from scattered tabs, spreadsheets, and inbox archaeology
into one system: a web app where a user tracks the companies they care about, the
jobs those companies post, and the applications they send — with discovery bots
keeping the feed fresh so the user's attention goes to converting, not collecting.

**Who it is for.** Job seekers running a serious, sustained search — starting with
founding users who are free forever. The measured funnel says discovery is solved
(roughly ten discovered roles for every one worth pursuing); the bottleneck is
conversion. The product exists to serve that bottleneck: a trustworthy pipeline,
honest statuses, and evidence for every claim it makes.

**What it does at the pilot.** Google sign-in and activation; a Today view of what
needs attention; Jobs discovered across the user's tracked companies; Applications
with manual, authoritative status; company Coverage with review states; Settings;
import and export of the user's data. Autopilot (prepare → review → submit) is in
scope for the product but deferred past the pilot; Gmail mailbox ingestion is the
sole product exclusion — Google auth never requests mail scopes.

**What it will not do.** Mutate application status behind the user's back. Submit
anything a user has not approved, to any provider not on the capability matrix.
Answer identity, authorization, EEO, or compensation questions it was never told.
Bypass CAPTCHAs, automate LinkedIn user sessions, or send outreach as the user.

**Principles.** Postgres is authoritative for product data; the web app is the only
human surface. Ownership is derived from authentication and defaults to deny.
Fail loud over guessing. Fixture parity for every production capability. Boring,
rented infrastructure over hand-rolled machinery, except where the write path's
rigor is the product.
