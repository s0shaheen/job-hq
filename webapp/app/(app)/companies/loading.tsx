/**
 * Skeleton with the SAME dimensions as the loaded page, so nothing jumps when data
 * lands (matrix row 7). Class-for-class with page.tsx / companies-grid.tsx /
 * coverage-meter.tsx: same h-dvh flex column, same header paddings and h-7 action
 * button, same h-7 toolbar controls, the coverage rail's own band, and a 32px
 * column-header rail over 32px rows.
 *
 * The coverage band is the part most worth mirroring: it sits BETWEEN the toolbar
 * and the grid, so omitting it here would move every row of the grid down by its
 * height the instant real data arrived — which is exactly the jump the queue's
 * skeleton once caused by leaving out the page header.
 */
export default function CompaniesLoading() {
  return (
    <div
      data-testid="companies-skeleton"
      aria-busy="true"
      aria-live="polite"
      className="flex h-dvh min-w-0 flex-col"
    >
      <span className="sr-only">Loading companies</span>

      {/* Mirrors page.tsx's header: text-lg title (24px line box) over a text-xs
          subtitle (16px), with the h-7 "Add companies" button on the right. */}
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <div className="h-6 w-28 animate-pulse rounded bg-raised" />
          <div className="h-4 w-80 max-w-full animate-pulse rounded bg-raised" />
        </div>
        <div className="h-7 w-28 animate-pulse rounded-md bg-raised" />
      </header>

      {/* Mirrors the grid toolbar: switcher + search + count line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
        <div className="h-7 w-32 animate-pulse rounded-md bg-raised" />
        <div className="h-7 w-40 animate-pulse rounded-md bg-raised sm:w-56" />
        <div className="h-4 w-56 max-w-full animate-pulse rounded bg-raised" />
      </div>

      {/* Mirrors the coverage meter: headline row, 1.5px rail, legend row.
          The headline block is h-6, NOT h-4 — that row is a flex containing the
          "How this is counted" toggle, which is `h-6` and therefore sets the row's
          height. Measured, not assumed: at h-4 the whole band came out 67px against
          the loaded 75, and every grid row below it jumped 8px when data landed
          (caught by companies.spec.ts's rail measurement, which is the only reason
          this comment can be specific). */}
      <div className="shrink-0 border-b border-border px-4 py-2 sm:px-6">
        <div className="h-6 w-72 max-w-full animate-pulse rounded bg-raised" />
        <div className="mt-1.5 h-1.5 w-full animate-pulse rounded-sm bg-raised" />
        <div className="mt-1.5 h-4 w-64 max-w-full animate-pulse rounded bg-raised" />
      </div>

      {/* The grid: a 32px column-header rail over 32px rows. overflow-hidden, not
          auto — a skeleton must not offer a scrollbar into nothing. */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        <div
          data-testid="companies-skeleton-colheads"
          className="flex h-8 items-center gap-6 border-b border-border-strong bg-raised px-3"
        >
          <div className="h-3 w-24 animate-pulse rounded bg-border" />
          <div className="h-3 w-24 animate-pulse rounded bg-border" />
          <div className="hidden h-3 w-32 animate-pulse rounded bg-border sm:block" />
          <div className="hidden h-3 w-16 animate-pulse rounded bg-border sm:block" />
          <div className="hidden h-3 w-14 animate-pulse rounded bg-border lg:block" />
        </div>
        {Array.from({ length: 16 }).map((_, i) => (
          <div key={i} className="flex h-8 items-center gap-6 border-b border-border px-3">
            <div className="h-3.5 w-32 animate-pulse rounded bg-raised" />
            <div className="h-[22px] w-28 animate-pulse rounded-md bg-raised" />
            <div className="hidden h-3.5 w-40 max-w-[30%] animate-pulse rounded bg-raised sm:block" />
            <div className="hidden h-3.5 w-20 animate-pulse rounded bg-raised sm:block" />
            <div className="hidden h-3.5 w-14 animate-pulse rounded bg-raised lg:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
