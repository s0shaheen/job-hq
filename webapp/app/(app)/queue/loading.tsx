/**
 * Skeleton with the SAME dimensions as the real page, so nothing jumps when
 * data lands. A spinner replaced by taller content is a layout shift, which
 * reads as jank even when the load was fast.
 *
 * It has to mirror the whole page, not just the rows. This file used to render
 * the card area alone while `page.tsx` rendered a header above it, so every
 * skeleton element jumped down by the height of that header the moment data
 * arrived. The doc claimed "no layout shift" and the measured shift was 69px.
 *
 * Nothing caught it, because the matrix row cited this component as its own
 * enforcement. `tests/e2e/loading.spec.ts` "the queue skeleton and the loaded
 * queue put the first row in the same place" measures THIS skeleton against
 * the loaded page and fails on a difference. The claim was false for a while
 * on this branch — that spec drove `/pipeline` and `/jobs` only, so the
 * geometry below was hand-checked and machine-unenforced. It is enforced now.
 *
 * Shaped like the content it replaces (01 §10): a page header, a section
 * header, and six two-line rows on the same 760px column at the same row
 * height. Never a spinner over the list.
 */
export default function QueueLoading() {
  return (
    <div
      className="min-w-0 p-4 md:p-6"
      aria-busy="true"
      aria-live="polite"
      data-testid="queue-skeleton"
    >
      <span className="sr-only">Loading your queue</span>

      <div className="mx-auto max-w-[760px]">
        {/* Mirrors PageHeader: a 20px/28px title on the same line as the
            Export control. */}
        <div className="flex items-start justify-between gap-4">
          <div className="h-7 w-28 animate-pulse rounded bg-raised" />
          <div className="h-8 w-24 animate-pulse rounded-md bg-raised" />
        </div>

        <div className="mt-8">
          {/* text-xs section header, 16px line box, with its 4px gap. */}
          <div className="mb-1 h-4 w-32 animate-pulse rounded bg-raised" />
          <ul className="border-t border-border">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li
                key={i}
                data-testid="queue-skeleton-row"
                className="flex items-start gap-3 border-b border-border px-2 py-3"
              >
                <div className="mt-0.5 size-4 shrink-0 animate-pulse rounded-sm bg-raised" />
                <div className="mt-0.5 size-5 shrink-0 animate-pulse rounded-sm bg-raised" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {/* 20px line box for the company/title line, then the fact
                      line at the same height. */}
                  <div className="h-5 w-2/3 animate-pulse rounded bg-raised" />
                  <div className="h-5 w-1/2 animate-pulse rounded bg-raised" />
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* The three shortcut lines, so the footer does not arrive late and
            push nothing. */}
        <ul className="mt-6 space-y-0.5">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-4 w-40 animate-pulse rounded bg-raised" />
          ))}
        </ul>
      </div>
    </div>
  );
}
