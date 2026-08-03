/**
 * The Prepare skeleton.
 *
 * `/apply/[applicationId]` had no `loading.tsx` either, and it is the surface
 * that most needs one: the page fetches a third-party board's question schema
 * before it can render anything, so the wait is a network round trip to somebody
 * else's server rather than a database read.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NO DESIGN IS BEING APPLIED HERE
 *
 * The owner's bundle authors a template for the Applications LIST
 * (`templates/applications/Applications.dc.html`) and none for Prepare — there
 * is no `apply`, `prepare` or `review` template in `project/templates/`. So this
 * mirrors the page's CURRENT chrome class-for-class rather than proposing one:
 * same bordered header block, same paddings, same `max-w-3xl` column. When
 * Prepare's own composition is authored, this moves with it.
 *
 * The measurement it has to satisfy is the same one every skeleton in this app
 * does (matrix row 7): the header sits where the loaded header sits, so nothing
 * jumps when the board answers.
 */
export default function ApplyLoading() {
  return (
    <div data-testid="apply-skeleton" aria-busy="true" aria-live="polite" className="min-w-0">
      <span className="sr-only">Loading this application</span>

      {/* Mirrors `page.tsx`'s header: a breadcrumb line, an `text-lg` title
          (28px line box), then a two-line `text-xs` description. */}
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="h-4 w-16 animate-pulse rounded bg-raised" />
        <div className="mt-1 h-7 w-72 max-w-full animate-pulse rounded bg-raised" />
        <div className="mt-1 h-4 w-full max-w-xl animate-pulse rounded bg-raised" />
      </header>

      <div className="mx-auto max-w-3xl px-4 pt-8 sm:px-6">
        {/* The staged form: a label over a field, repeated. Not a spinner —
            a spinner over a form says "wait" and says nothing about what is
            coming, and this page's whole value is the shape of what is coming. */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="mb-6">
            <div className="h-3 w-40 max-w-full animate-pulse rounded bg-border" />
            <div className="mt-2 h-9 w-full animate-pulse rounded-md bg-raised" />
          </div>
        ))}
      </div>
    </div>
  );
}
