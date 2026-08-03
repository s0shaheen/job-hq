/**
 * Calendar arithmetic on the user's LOCAL day.
 *
 * Extracted so it can be tested against a pinned clock and a pinned timezone.
 * `new Date(...).toISOString().slice(0, 10)` reads like "today as a date" and
 * is actually "the UTC day", which differs from the local day for most of the
 * evening anywhere west of Greenwich. A snooze set at 23:50 in Chicago was
 * stored a day late, which acceptance criterion 14 forbids — and which nobody
 * notices, because the symptom is a row quietly reappearing later than asked.
 */

/** `YYYY-MM-DD` for a Date, read in local time. */
export function toLocalIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `n` days from now on the local calendar.
 *
 * Uses `setDate`, which rolls months and years and — unlike adding
 * `n * 86_400_000` milliseconds — stays on the intended calendar day across a
 * daylight-saving boundary, where a day is 23 or 25 hours long.
 */
export function localIsoDaysFromNow(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + days);
  return toLocalIsoDate(d);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** `YYYY-MM-DD` to a count of days, or null. Calendar arithmetic with NO
 *  timezone in it: `Date.UTC` of three integers is the same number in every
 *  zone, which is the whole point — see `postedAge`. */
function calendarDay(iso: string): { days: number; monthIndex: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  return { days: Date.UTC(year, monthIndex, day) / 86_400_000, monthIndex, day };
}

/**
 * How long ago a posting was published, for Today's fact line (02 §8:
 * relative under a week, then an absolute date).
 *
 * BOTH ARGUMENTS ARE `YYYY-MM-DD` STRINGS, and that signature is the fix for a
 * real bug rather than a style choice.
 *
 * The first version took `now: Date` and derived the current day with
 * `getFullYear/getMonth/getDate`. Passing a server timestamp down as a prop
 * removed clock DRIFT between the two renders but not the TIMEZONE those three
 * getters read: they answer in the server's zone on the server and in the
 * user's zone in the browser. At 02:00Z with a US user that is a different
 * calendar day on each side, so the server rendered "1d ago", the client
 * rendered "Today", and React silently re-rendered the text — which is exactly
 * the hydration flicker the previous comment claimed to have designed out.
 *
 * Nothing here reads a local zone now. `today` is computed once on the server
 * with `toLocalIsoDate` and travels as a string; both sides then do integer
 * arithmetic on two calendar dates, which cannot disagree.
 *
 * DAY granularity, not hours, and that is a data limit rather than a taste.
 * `posted` is a `YYYY-MM-DD` date: the board states a day, not a timestamp.
 * The owner's composition shows "6h ago" on its top row; there is no hour in
 * this column to render, and inventing one would put a precision on screen the
 * source does not have. Recorded as a gap rather than guessed.
 */
export function postedAge(posted: string | null, today: string): string | null {
  if (!posted) return null;
  const then = calendarDay(posted);
  const now = calendarDay(today);
  if (!then || !now) return null;

  const days = now.days - then.days;

  // A posting dated in the future is a board's clock, not ours. It reads as
  // today rather than "-1d ago".
  if (days <= 0) return "Today";
  if (days < 7) return `${days}d ago`;
  return `${MONTHS[then.monthIndex]} ${then.day}`;
}
