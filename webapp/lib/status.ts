/**
 * The application-status vocabulary — one module, every surface.
 *
 * It lived in three places before this: `app/(app)/pipeline/page.tsx`,
 * `lib/queries.ts`, and `core/schema.py`. Two of those were the same eleven
 * strings typed out twice, and the third is the authority — the engine writes
 * these values into the sheet and into `applications.status`, so a webapp copy
 * that drifts renders a real row into the wrong group or, worse, sorts it into
 * a stage it was never in.
 *
 * `tests/unit/status.test.ts` parses `core/schema.py` and compares. That is the
 * only kind of parity check that survives someone editing one side in a hurry:
 * a comment saying "keep in step with schema.py" is not a mechanism.
 *
 * Deliberately surface-neutral (`lib/status.ts`, not `lib/pipeline/statuses.ts`)
 * — docs/plans/README.md conflict C4. Import consumes it too, to map a
 * spreadsheet's status column onto the vocabulary, and a module living under
 * `pipeline/` would have been copied rather than imported.
 */

/** Bot-advanceable, forward only. Order IS the pipeline order. */
export const STATUS_ORDER = [
  "Inbox",
  "Queued",
  "Applied",
  "OA",
  "Screen",
  "Interview",
  "Final",
  "Offer",
] as const;

/** Ended without an offer. A bot may write these, with evidence. */
export const STATUS_TERMINAL = ["Rejected", "Withdrawn", "Closed"] as const;

/**
 * Ended WITH one, and human-only.
 *
 * No bot may write these — the enforcement is in the engine
 * (`tracker/join.py` can only write statuses `EVENT_STATUS_RULES` names, and it
 * structurally cannot name these) and in the database (`app_set_status` stamps
 * `status_actor='user'`, which locks the row against every later bot write).
 * The UI only offers them from `Offer`, because that is the only place they
 * mean anything.
 */
export const STATUS_RESOLVED = ["Offer-Accepted", "Offer-Declined"] as const;

/** Every canonical status, in the order a grouped view should present them. */
export const STATUSES: readonly string[] = [
  ...STATUS_ORDER,
  ...STATUS_TERMINAL,
  ...STATUS_RESOLVED,
];

/** Who last set a row's status. `user` locks it against every bot write. */
export type StatusActor = "system" | "user";

/**
 * Rank for forward-only comparisons — the port of `core/schema.py:status_rank`.
 *
 * Kept in the web app because the pipeline sorts and groups by it, and because
 * Import needs to know whether a spreadsheet's value moves a row forward. The
 * tiers, and why each sits where it does:
 *
 *   -1  empty        — nothing has happened yet
 *   0-7 STATUS_ORDER — the pipeline proper, in order
 *   9   TERMINAL     — above Offer, so a bot never "reopens" a closed row
 *   10  RESOLVED     — above terminal: an accepted offer outranks a rejection
 *                      that arrives afterwards from some other thread
 *   11  invented     — a human typed something; untouchable by construction
 *
 * Rank is NOT the human-wins mechanism. `Rejected` outranks `Offer`, which is
 * exactly how a 0.99-confidence rejection used to overwrite an Offer somebody
 * had chosen. `statusActor` is what protects that; see `db/migrations/0010`.
 */
export function statusRank(status: string): number {
  const s = (status ?? "").trim();
  if (!s) return -1;
  const i = (STATUS_ORDER as readonly string[]).indexOf(s);
  if (i !== -1) return i;
  if ((STATUS_TERMINAL as readonly string[]).includes(s)) return STATUS_ORDER.length + 1;
  if ((STATUS_RESOLVED as readonly string[]).includes(s)) return STATUS_ORDER.length + 2;
  return STATUS_ORDER.length + 3;
}

/** Is this one of the statuses the vocabulary defines, as opposed to invented? */
export function isCanonicalStatus(status: string): boolean {
  return STATUSES.includes((status ?? "").trim());
}

/**
 * The group a row belongs to in the pipeline's grouped view.
 *
 * An invented status collapses into one "Other" group rather than getting a
 * group of its own. Both behaviours are defensible; this one is chosen because
 * the alternative lets a typo ("Aplied") mint a permanent group that looks like
 * a stage. The row itself still shows its own text — nothing is hidden, and the
 * group header says how many are in there.
 */
export const OTHER_GROUP = "Other";

export function statusGroup(status: string): string {
  const s = (status ?? "").trim();
  if (!s) return OTHER_GROUP;
  return isCanonicalStatus(s) ? s : OTHER_GROUP;
}

/** Group order for the grouped view: ladder order, then Other, always last. */
export function groupRank(group: string): number {
  if (group === OTHER_GROUP) return STATUSES.length;
  const i = STATUSES.indexOf(group);
  return i === -1 ? STATUSES.length : i;
}

/**
 * Terminal in the "this application is over" sense — what Reopen is offered on.
 *
 * `STATUS_RESOLVED` is deliberately NOT here. An accepted offer is over in a way
 * a rejection is not: reopening it is not a correction, it is a different
 * decision, and the honest gesture there is to say so in a note rather than to
 * quietly rewind the row.
 */
export function isTerminalStatus(status: string): boolean {
  return (STATUS_TERMINAL as readonly string[]).includes((status ?? "").trim());
}

export function isReopenable(status: string): boolean {
  return isTerminalStatus(status);
}

/**
 * The statuses the UI offers for a row currently at `status`.
 *
 * `STATUS_RESOLVED` appears only from `Offer`, because "Offer-Declined" on a row
 * that never had an offer is not a state anything can reach honestly. Everything
 * else is always offered: moving a row backwards is a legitimate human
 * correction (the bots are the ones who may only go forward), and refusing it
 * would make a mis-click permanent.
 */
export function selectableStatuses(status: string): string[] {
  const current = (status ?? "").trim();
  const base: string[] = [...STATUS_ORDER, ...STATUS_TERMINAL];
  if (current === "Offer" || (STATUS_RESOLVED as readonly string[]).includes(current)) {
    base.push(...STATUS_RESOLVED);
  }
  // A human-invented status is offered back to itself so the Select has
  // something to display, rather than rendering an empty trigger over a row
  // whose status is plainly visible in the sheet it came from.
  if (current && !base.includes(current)) base.push(current);
  return base;
}

/** Badge tone per status. Shared so the queue and the pipeline agree. */
export type StatusTone = "ok" | "accent" | "info" | "warn" | "neutral";

export function statusTone(status: string): StatusTone {
  const s = (status ?? "").trim();
  if (s === "Offer" || s === "Offer-Accepted") return "ok";
  if ((["OA", "Screen", "Interview", "Final"] as string[]).includes(s)) return "accent";
  if (s === "Applied") return "info";
  return "neutral";
}
