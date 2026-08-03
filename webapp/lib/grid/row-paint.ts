/**
 * A GRID ROW'S PAINT, DECLARED ONCE.
 *
 * Both scrolling grids (`/jobs`, `/companies`) pin their first column with
 * `position: sticky`, and a sticky cell must be OPAQUE or the columns scrolling
 * underneath show through it. That opacity is what makes this file necessary:
 * an opaque cell has to restate its row's background, and the row and the cell
 * are two elements a hundred lines apart in the same JSX.
 *
 * They each used to enumerate the states themselves, which held exactly until a
 * THIRD state was added to one of them. The detail pane's subject row went
 * `raised`; its pinned first cell still listed only `selected` and the default,
 * so it stayed `surface` — a seam down the left edge of the row the user was
 * reading, and the visual baseline suite photographed it and accepted it.
 *
 * So neither element names a colour any more. The ROW sets `--row-bg`; anything
 * that needs the row's background reads it and inherits every future state for
 * free. Adding a fourth state is one edit in `rowPaint`, and there is no second
 * list to forget.
 *
 * The variable holds a raw token (`--surface`, not `--color-surface`): the
 * `--color-*` layer exists to map tokens onto Tailwind utility names, and this
 * is not a utility name.
 */

/**
 * What the row paints, and what it publishes to its cells.
 *
 * The default state resolves to `surface` rather than staying transparent. That
 * is not a visual change — both grids sit in a `bg-surface` container — and it
 * is what lets the sticky cell read one variable in every state instead of
 * carrying a base colour plus a `group-hover:` override of its own.
 */
export function rowPaint(state: { selected: boolean; paneSubject?: boolean }): string {
  if (state.selected) return "bg-[var(--row-bg)] [--row-bg:var(--selected)]";
  if (state.paneSubject) return "bg-[var(--row-bg)] [--row-bg:var(--raised)]";
  // `hover:` on the ROW, so the whole row re-tints together — including the
  // pinned cell, which inherits the variable rather than needing `group-hover:`.
  return "bg-[var(--row-bg)] [--row-bg:var(--surface)] hover:[--row-bg:var(--raised)]";
}

/** What a sticky cell paints. The row already decided; the cell just obeys. */
export const STICKY_CELL_PAINT = "bg-[var(--row-bg)]";

/**
 * THE KEYBOARD CURSOR — a pseudo-element, not `ring-1 ring-inset` on the row.
 *
 * `ring-inset` is a box-shadow, and a box-shadow paints in the ROW's own
 * background layer. The sticky cell is a CHILD with `z-10` and (necessarily) an
 * opaque background, so it painted straight over the cursor: the outline died at
 * the pinned column's left edge and reappeared on its right. Measured at 171px
 * of missing ring on /jobs and 482px on /companies.
 *
 * Why `::after` and not an overlay `<div>`: `role="row"` may contain gridcells
 * and nothing else. An extra child is an ARIA break that the axe sweeps would
 * rightly fail, and it would need `aria-hidden` plus a presentation role to be
 * tolerated. A pseudo-element is invisible to the accessibility tree by
 * construction, and it is the last thing the row paints.
 *
 * Why `z-15`: it has to beat the sticky CELL at `z-10` and stay under the sticky
 * HEADER row at `z-20`, which every scrolled row passes beneath. Picking `z-10`
 * would work today by tree order alone, which is not a thing to depend on.
 */
export const ROW_CURSOR =
  "after:pointer-events-none after:absolute after:inset-0 after:z-15 " +
  "after:ring-1 after:ring-inset after:ring-ring";
