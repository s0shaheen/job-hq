/**
 * Deterministic date/number formatting. No locale APIs — server- and
 * client-rendered output must match byte-for-byte (hydration safety), and the
 * family reads the same strings regardless of machine locale. All in UTC.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Jul 19" (adds the year when it isn't the current one). */
export function fmtDay(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "—";
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? day
    : `${day} ${d.getUTCFullYear()}`;
}

/** "Jul 19 14:02 UTC" */
export function fmtStamp(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${fmtDay(iso)} ${hh}:${mm} UTC`;
}

/** Hours elapsed since `iso`, or null if unparseable. */
export function hoursSince(iso: string | null | undefined): number | null {
  const d = parse(iso);
  if (!d) return null;
  return (Date.now() - d.getTime()) / 3_600_000;
}

/** "0.4 h" / "26 h" — one decimal under 10 h, whole hours above. */
export function fmtHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 0) return "0 h";
  return h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h)} h`;
}
