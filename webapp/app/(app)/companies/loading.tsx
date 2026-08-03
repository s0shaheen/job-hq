/**
 * Skeleton with the SAME dimensions as the loaded page, so nothing jumps when data
 * lands (matrix row 7). Class-for-class with page.tsx / companies-grid.tsx /
 * coverage-summary.tsx: same h-dvh flex column, same header paddings, the same
 * text-xl title line over the same 32px tab strip and caveat line, same h-7
 * toolbar controls, the summary sentence's own band, and a 32px column-header
 * rail over 32px rows.
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

      {/* Mirrors page.tsx's header: PageHeader's text-xl title (28px line box)
          beside the primary action, then the 32px tab strip at mt-4, then the
          text-xs caveat line (16px) at mt-3. */}
      <header className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="h-7 w-32 animate-pulse rounded bg-raised" />
          <div className="h-8 w-32 animate-pulse rounded-md bg-raised" />
        </div>
        <div className="mt-4 flex gap-0.5">
          <div className="h-8 w-24 animate-pulse rounded-md bg-raised" />
          <div className="h-8 w-28 animate-pulse rounded-md bg-raised" />
          <div className="h-8 w-20 animate-pulse rounded-md bg-raised" />
        </div>
        <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-raised" />
      </header>

      {/* Mirrors the grid toolbar: switcher + search + count line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
        <div className="h-7 w-32 animate-pulse rounded-md bg-raised" />
        <div className="h-7 w-40 animate-pulse rounded-md bg-raised sm:w-56" />
        <div className="h-4 w-56 max-w-full animate-pulse rounded bg-raised" />
      </div>

      {/* Mirrors the summary sentence: ONE `text-sm` line (20px line box) in a
          `py-2` band. The band the meter needed was three rows tall; this one is
          one row, and the height has to follow it down or the grid jumps upward
          when data lands — the same defect the meter's own comment recorded in
          the other direction. */}
      <div className="shrink-0 border-b border-border px-4 py-2 sm:px-6">
        <div className="h-5 w-96 max-w-full animate-pulse rounded bg-raised" />
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
