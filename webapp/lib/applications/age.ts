/**
 * "Applied 12d ago" — the row's and the pane's status-age line.
 *
 * ONE copy, imported by both. It was written twice during the Applications
 * cutover, once in the row and once in the pane, which is the shape this
 * codebase has repeatedly paid for: a second copy is a second place for one to
 * rot, and the two would have drifted the first time somebody adjusted the
 * wording in the surface they happened to have open.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY IT SAYS "Applied" AND NOT THE CURRENT STATUS
 *
 * The authored template's line is generic — "<current status> Nd ago" — and this
 * app cannot render it. `applications.status_set_at` is in the row JSON
 * (`0010_pipeline.sql`) and is NOT mapped into `ApplicationView`, so the only
 * stamp available here is the applied date.
 *
 * "Applied Nd ago" from `appliedDate` is true. Relabelling that same number with
 * the current status would not be: a row that reads "Rejected 12d ago" when it
 * means "applied 12 days ago" states a fact about the rejection that nobody
 * measured. Surfacing `status_set_at` is a view-model change, and until it
 * happens this says the smaller true thing.
 *
 * `Not listed` for an absent or unparseable date, never a blank cell — a blank
 * says "no information exists" when the truth is "this row was typed in or
 * imported, not applied to through this app".
 */

const DAY_MS = 86_400_000;

export function appliedAge(appliedDate: string | null | undefined, now = Date.now()): string {
  if (!appliedDate) return "Not listed";
  const then = Date.parse(appliedDate);
  if (Number.isNaN(then)) return "Not listed";
  // Clamped at zero. A date in the future is a real row — somebody typed
  // tomorrow's date, or a spreadsheet carried one — and "Applied -3d ago" is a
  // worse answer than treating it as today.
  const days = Math.max(0, Math.floor((now - then) / DAY_MS));
  return days === 0 ? "Applied today" : `Applied ${days}d ago`;
}
