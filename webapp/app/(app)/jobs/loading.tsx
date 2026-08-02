/**
 * Skeleton with the SAME dimensions as the loaded grid, so nothing jumps when
 * data lands. Matrix row 7's history is the reason this mirrors the WHOLE
 * page: the queue's skeleton once omitted the page header and every element
 * jumped 69px on load while the doc claimed "no layout shift". grid.spec.ts
 * measures this skeleton against the loaded page the same way
 * tests/e2e/loading.spec.ts measures the queue's — the row has a test, not a
 * promise.
 *
 * Class-for-class with page.tsx / jobs-table.tsx: same flex column, same
 * header paddings, same h-7 toolbar controls, same 32px column-header rail and
 * 32px rows.
 */
export default function JobsLoading() {
  return (
    <div
      data-testid="jobs-skeleton"
      data-bounded-frame=""
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-0 min-w-0 flex-1 flex-col p-4 md:p-6"
    >
      <span className="sr-only">Loading roles</span>

      {/* Mirrors page.tsx's header: text-lg title (24px line box) over a
          text-xs subtitle (16px). */}
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div>
          <div className="h-7 w-16 animate-pulse rounded bg-raised" />
          <div className="mt-0.5 h-5 w-72 max-w-full animate-pulse rounded bg-raised" />
        </div>
        <div className="h-8 w-20 animate-pulse rounded-md bg-raised" />
      </header>

      {/* Mirrors the redesigned toolbar: four controls, then Display at the
          right edge. Class-for-class with `TableToolbar`, including the wrap.

          #114's failure mode cannot occur here, and the reason is worth stating
          because the fix looks absent otherwise: the rail moved 22px in CI
          because the COUNT shared the toolbar row and wrapped differently under
          Linux fonts. The authored design puts the count in the scope footer
          under the table, so this row holds controls only. The half of #114
          that does transfer — search as the flexible filler, which can never be
          the item that pushes the bar onto a second row — lives in
          jobs-table.tsx, and `TableToolbar` states why the other half is
          deliberately not applied. */}
      <div className="mt-4 flex h-[116px] shrink-0 flex-wrap items-center gap-2 md:h-8">
        <div className="h-8 w-[250px] max-w-full animate-pulse rounded-md bg-raised" />
        <div className="h-8 w-72 max-w-full animate-pulse rounded-md bg-raised" />
        <div className="h-8 w-20 animate-pulse rounded-md bg-raised" />
        <div className="h-8 w-28 animate-pulse rounded-md bg-raised" />
      </div>

      {/* The grid: a 32px column-header rail over 32px rows. overflow-hidden,
          not auto — a skeleton must not offer a scrollbar into nothing. */}
      <div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
        <div
          data-testid="jobs-skeleton-colheads"
          className="flex h-10 items-center gap-6 border-b border-border-strong bg-surface px-3"
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
            className="flex h-10 items-center gap-6 border-b border-border px-3"
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
