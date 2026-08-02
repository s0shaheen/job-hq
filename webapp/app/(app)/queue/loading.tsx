/**
 * Skeleton with the SAME dimensions as the real page, so nothing jumps when
 * data lands. A spinner replaced by taller content is a layout shift, which
 * reads as jank even when the load was fast.
 *
 * It has to mirror the whole page, not just the card. This file used to render
 * the card area alone while `page.tsx` renders a header above it — title,
 * Export button, subtitle — so every skeleton element jumped down by the height
 * of that header the moment data arrived, and the card itself grew as well. The
 * doc claimed "no layout shift" and the measured shift was 69px.
 *
 * Nothing caught it, because the matrix row cited this component as its own
 * enforcement. `tests/e2e/loading.spec.ts` now measures the skeleton against
 * the loaded page and fails on a difference — the row has a test rather than a
 * promise.
 */
export default function QueueLoading() {
  return (
    <div className="min-w-0" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your queue</span>

      {/* Mirrors page.tsx's header exactly: title row (with the Export button's
          footprint) above a subtitle line. */}
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="h-6 w-40 animate-pulse rounded bg-raised" />
          <div className="h-7 w-24 animate-pulse rounded-md bg-raised" />
        </div>
        <div className="mt-1 h-4 w-72 max-w-full animate-pulse rounded bg-raised" />
      </header>

      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <div className="mb-3 h-4 w-24 animate-pulse rounded bg-raised" />
        <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <div className="h-5 w-28 animate-pulse rounded bg-raised" />
          {/* text-xl title: 28px of line box, not 24. */}
          <div className="mt-2 h-7 w-3/4 animate-pulse rounded bg-raised" />
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="bg-surface px-3 py-2">
                {/* fact value is text-sm (20px), label is text-2xs (16px) */}
                <div className="h-5 w-16 animate-pulse rounded bg-raised" />
                <div className="mt-1 h-4 w-10 animate-pulse rounded bg-raised" />
              </div>
            ))}
          </div>
          <div className="mt-4 h-4 w-1/3 animate-pulse rounded bg-raised" />
        </div>
      </div>
    </div>
  );
}
