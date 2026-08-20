/**
 * The Applications skeleton — the template's `loading` frame.
 *
 * This surface had NO `loading.tsx` at all before, which is a specific failure
 * rather than a missing nicety: a client-side navigation to /pipeline showed the
 * previous surface frozen until the data landed, and the coverage ledger's
 * `applications | Loading` cell cited a test that photographs the JOBS skeleton
 * on its way past. There was nothing here to photograph.
 *
 * PER-BAND SKELETON ROWS, SHAPED LIKE REAL ROWS — never a spinner over the list
 * (01 §8, §10). Class-for-class with `pipeline-table.tsx`: same page padding,
 * same header block, same `mt-6` band spacing, same 12px band label, same
 * rounded card, same `hq-row` height and the same four-column track list. Matrix
 * row 7's history is why that matters — the queue's skeleton once omitted the
 * page header and every element jumped 69px when data landed while the doc
 * claimed "no layout shift".
 *
 * `aria-busy` and one `sr-only` line, not a per-element live region: a screen
 * reader announcing twelve grey rectangles is worse than one that says the page
 * is loading.
 *
 * NO `data-bounded-frame`. This surface is not virtualized and scrolls the
 * document; a skeleton that framed the viewport and a page that does not would
 * disagree about where the scrollbar lives, which is a jump of its own.
 */

/** Band label width, then the row count, matched to the fixture's shape. */
const SKELETON_BANDS = [
  { label: "w-24", rows: 5 },
  { label: "w-20", rows: 1 },
  { label: "w-20", rows: 3 },
];

export default function ApplicationsLoading() {
  return (
    <div
      data-testid="pipeline-skeleton"
      aria-busy="true"
      aria-live="polite"
      className="min-w-0 flex-1 p-4 md:p-6"
    >
      <span className="sr-only">Loading applications</span>

      {/* Mirrors `PageHeader`: an `text-xl` title (28px line box) over a
          `text-sm` subtitle (20px), with the export control on the baseline.

          `flex-wrap`, `min-w-0` and `max-w-full` ARE that mirror, not
          decoration — they are what `PageHeader` itself carries for the narrow
          viewport, and this block had none of them (issue #281). `w-40` is
          10rem, which is 320px once a large-text reader has doubled the root
          font size, and a 320px phone leaves 256px inside `p-4`. The title bar
          therefore painted from x=32 to x=352 and `html { overflow-x: hidden }`
          clipped it out of reach instead of letting the page scroll — the WCAG
          2.2 reflow failure the loaded header fixed for itself and the skeleton
          did not.

          `min-w-0` alone is not enough: it lets the flex ITEM shrink while a
          fixed-width child keeps painting past it. `max-w-full` alone is not
          enough either: the item's automatic minimum size is its min-content
          width, which that same fixed-width child pins at 10rem. Both, or the
          bar still hangs off the page. */}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="h-7 w-40 max-w-full animate-pulse rounded bg-raised" />
          <div className="mt-0.5 h-5 w-24 max-w-full animate-pulse rounded bg-raised" />
        </div>
        <div className="h-8 w-20 max-w-full animate-pulse rounded-md bg-raised" />
      </header>

      {SKELETON_BANDS.map((band, i) => (
        <section key={i} className="mt-6 first:mt-4">
          {/* The band label: 16px line box, matching the `text-xs` heading. */}
          <div className="flex h-4 items-center gap-2">
            <div className="size-3.5 shrink-0 animate-pulse rounded bg-raised" />
            <div className={`h-3 ${band.label} animate-pulse rounded bg-border`} />
          </div>

          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {Array.from({ length: band.rows }).map((_, r) => (
              <div
                key={r}
                className="hq-row grid grid-cols-1 items-center gap-x-2 gap-y-1 px-2
                           md:grid-cols-[minmax(220px,1fr)_130px_150px_minmax(190px,280px)]"
              >
                <span className="flex min-w-0 items-center gap-2 px-2">
                  <span className="size-4 shrink-0 animate-pulse rounded-sm bg-border" />
                  <span className="h-3 w-32 animate-pulse rounded bg-border" />
                </span>
                <span className="px-2 md:text-right">
                  <span className="inline-block h-3 w-20 max-w-full animate-pulse rounded bg-border" />
                </span>
                <span className="px-1">
                  <span className="block h-3 w-20 animate-pulse rounded bg-border" />
                </span>
                <span className="px-1">
                  <span className="block h-3 w-40 max-w-full animate-pulse rounded bg-border" />
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* The same reserved strip the loaded surface keeps, so the document is
          the same height in both frames and the page does not lose its
          scrollbar for the duration of the load. */}
      <div aria-hidden="true" className="h-40" />
    </div>
  );
}
