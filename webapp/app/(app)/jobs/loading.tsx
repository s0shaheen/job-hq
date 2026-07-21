/**
 * Skeleton with the SAME dimensions as the loaded grid, so nothing jumps when
 * data lands. Matrix row 7's history is the reason this mirrors the WHOLE
 * page: the queue's skeleton once omitted the page header and every element
 * jumped 69px on load while the doc claimed "no layout shift". grid.spec.ts
 * measures this skeleton against the loaded page the same way
 * tests/e2e/loading.spec.ts measures the queue's — the row has a test, not a
 * promise.
 *
 * Class-for-class with page.tsx / jobs-grid.tsx: same h-dvh flex column, same
 * header paddings, same h-7 toolbar controls, same 32px column-header rail and
 * 32px rows.
 */
export default function JobsLoading() {
  return (
    <div
      data-testid="jobs-skeleton"
      aria-busy="true"
      aria-live="polite"
      className="flex h-dvh min-w-0 flex-col"
    >
      <span className="sr-only">Loading postings…</span>

      {/* Mirrors page.tsx's header: text-lg title (24px line box) over a
          text-xs subtitle (16px). */}
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <div className="h-6 w-16 animate-pulse rounded bg-raised" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded bg-raised" />
      </header>

      {/* Mirrors the grid toolbar: h-7 set toggle + count line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
        <div className="h-7 w-36 animate-pulse rounded-md bg-raised" />
        <div className="h-4 w-64 max-w-full animate-pulse rounded bg-raised" />
      </div>

      {/* The grid: a 32px column-header rail over 32px rows. overflow-hidden,
          not auto — a skeleton must not offer a scrollbar into nothing. */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        <div
          data-testid="jobs-skeleton-colheads"
          className="flex h-8 items-center gap-6 border-b border-border-strong bg-raised px-3"
        >
          <div className="h-3 w-20 animate-pulse rounded bg-border" />
          <div className="h-3 w-40 animate-pulse rounded bg-border" />
          <div className="hidden h-3 w-20 animate-pulse rounded bg-border sm:block" />
          <div className="hidden h-3 w-12 animate-pulse rounded bg-border sm:block" />
          <div className="hidden h-3 w-16 animate-pulse rounded bg-border lg:block" />
        </div>
        {Array.from({ length: 18 }).map((_, i) => (
          <div
            key={i}
            className="flex h-8 items-center gap-6 border-b border-border px-3"
          >
            <div className="h-3.5 w-24 animate-pulse rounded bg-raised" />
            <div className="h-3.5 w-56 max-w-[40%] animate-pulse rounded bg-raised" />
            <div className="hidden h-3.5 w-24 animate-pulse rounded bg-raised sm:block" />
            <div className="hidden h-3.5 w-10 animate-pulse rounded bg-raised sm:block" />
            <div className="hidden h-3.5 w-20 animate-pulse rounded bg-raised lg:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
