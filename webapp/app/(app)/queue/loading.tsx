/**
 * Skeleton with the SAME dimensions as the real card, so nothing jumps when
 * data lands. A spinner that is replaced by taller content is a layout shift,
 * which reads as jank even when the load was fast.
 */
export default function QueueLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your queue…</span>
      <div className="mb-3 h-4 w-24 animate-pulse rounded bg-raised" />
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="h-4 w-28 animate-pulse rounded bg-raised" />
        <div className="mt-2 h-6 w-3/4 animate-pulse rounded bg-raised" />
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface px-3 py-2">
              <div className="h-4 w-16 animate-pulse rounded bg-raised" />
              <div className="mt-1.5 h-2 w-10 animate-pulse rounded bg-raised" />
            </div>
          ))}
        </div>
        <div className="mt-4 h-4 w-1/3 animate-pulse rounded bg-raised" />
      </div>
    </div>
  );
}
