/**
 * The Applications surface's display BANDS.
 *
 * The owner's composition groups applications into collapsible bands rather than
 * one band per status (`job-hq-design-system/project/templates/applications/
 * Applications.dc.html`). A band is a pure display projection over the UNTOUCHED
 * status vocabulary in `lib/status.ts`: nothing here renames, adds, reorders or
 * writes a status, and no engine code imports this module. That is the whole
 * reason it lives beside the dictionary instead of inside it — `lib/status.ts`
 * is consumed by Import and is parity-checked against `core/schema.py`, and a
 * surface's grouping choice has no business in a file with that contract.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY AN INVENTED STATUS IS ACTIVE, NOT CLOSED
 *
 * `applications-handoff.md` §1 recommends folding the `Other` group (a status a
 * human typed) into **Closed**. The authored template disagrees and it is the
 * authority: its own fixture data puts "Waiting on referral" — not a canonical
 * status — in the **Active** band, beside Applied and Interviewing rows.
 *
 * The template is also right on the merits. Closed is collapsed by default, so
 * folding invented statuses into it would hide a live application behind a
 * chevron because somebody typed "waiting on panel" instead of picking from a
 * list. Failing towards "still live" is the direction that cannot lose work.
 *
 * The deviation is recorded rather than silently taken: DEV-003 in
 * `docs/pilot-launch/07-decisions-assumptions-risks.md`. A pointer at "the PR
 * body" used to sit here, which is a reference to a thing nobody can find in six
 * months — and on this branch the body did not even carry it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY ABSENT: "Needs review"
 *
 * The template renders a fourth band, pinned first, called "Needs review". Its
 * COMPOSITION is not derivable from the template — its sole fixture row is an
 * ordinary Screening row carrying no suggestion and no evidence, so the template
 * does not say what makes a row belong there, nor whether such a row is deduped
 * out of its status band or shown in both. `applications-handoff.md` §7 names it
 * open question #1 and says to resolve it before building the band function.
 *
 * So it is not built. Guessing here is not a cosmetic risk: a band that silently
 * swallows rows out of Active is a list that lies about how much work is in
 * flight. ADD-010 in `07-decisions-assumptions-risks.md` is the addendum this
 * waits on.
 */

import { STATUS_RESOLVED, STATUS_TERMINAL } from "@/lib/status";

/**
 * The bands, in the order they render.
 *
 * Values are used as URL keys in `?open=`, so they are single words on purpose:
 * a band name with a space would need encoding in a place a person reads.
 */
export const BANDS = ["Active", "Offers", "Closed"] as const;

export type Band = (typeof BANDS)[number];

/**
 * Which band a row's status renders in.
 *
 * Everything that is not an ended state is Active, including a status a human
 * invented. `Offer` is its own band because an offer is the outcome the surface
 * exists to produce, and burying it in the ladder is how it gets skimmed past;
 * `Offer-Accepted` and `Offer-Declined` join it because they are what became of
 * one, not a rejection that arrived from some other thread.
 */
export function statusBand(status: string): Band {
  const s = (status ?? "").trim();
  if (s === "Offer" || (STATUS_RESOLVED as readonly string[]).includes(s)) return "Offers";
  if ((STATUS_TERMINAL as readonly string[]).includes(s)) return "Closed";
  // Everything else — the live ladder, an empty status, and anything a human
  // typed. A status this function has never heard of is live work by default,
  // because the failure that costs something is hiding an open application.
  return "Active";
}

/** Render order. Used to sort the bands actually present, never to invent one. */
export function bandRank(band: string): number {
  const i = (BANDS as readonly string[]).indexOf(band);
  return i === -1 ? BANDS.length : i;
}

/**
 * Whether a band is open when the URL says nothing.
 *
 * Closed starts collapsed, which is the template's own initial state
 * (`state = { collapsed: { closed: true } }`). An explicit `?open=` overrides
 * this in both directions — including the empty value, which means everything
 * collapsed and is a state a person reaches by closing the last band.
 */
export function bandOpenByDefault(band: string): boolean {
  return band !== "Closed";
}
