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
