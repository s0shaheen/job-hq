/**
 * The Application answers skeleton — `profile-skeleton.tsx`'s idiom, drawn to
 * this surface's shape.
 *
 * The real surface is three `Section` cards in a centred `max-w-2xl` column:
 * Your situation (a stack of bordered topic rows), Saved answers (a divided
 * list), and Company exceptions. The skeleton draws that — a heading bar and a
 * blurb line per card, then row-shaped blocks where the topic rows and list
 * rows will land — because a card-shaped placeholder is what 04 §5 asks of
 * this state, and a centred spinner would pass an eye test and fail it.
 *
 * Deliberately NOT the empty state: `library-empty` and `exceptions-empty` are
 * claims that the server answered and found nothing, and a skeleton that
 * satisfied their locators would collapse "still asking" into "nothing there".
 * Nothing here carries either testid.
 *
 * Rendered as a `Suspense` fallback inside the page, never as a route
 * `loading.tsx`: the page header above it says where you are and its Search
 * profile link still works while the read is slow.
 *
 * `aria-hidden` plus one live region: a screen reader gets "Loading your
 * answers" once, not a dozen unlabelled boxes.
 */
function Bar({ className }: { className: string }) {
  return <span className={`block rounded bg-raised ${className}`} />;
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <Bar className="h-4 w-32" />
      <Bar className="mt-2 h-3 w-full max-w-96" />
      <div className="mt-3 flex flex-col gap-2">
        {Array.from({ length: rows }, (_, row) => (
          <span
            key={row}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <Bar className="h-3 w-40 max-w-full" />
            <Bar className="h-3 w-64 max-w-full" />
          </span>
        ))}
      </div>
    </div>
  );
}

export function AnswersSkeleton() {
  return (
    <div
      data-testid="answers-skeleton"
      className="mx-auto max-w-2xl px-4 pt-5 pb-40 sm:px-6"
    >
      <p className="sr-only" role="status">
        Loading your answers
      </p>
      <div aria-hidden className="space-y-3">
        <CardSkeleton rows={3} />
        <CardSkeleton rows={2} />
        <CardSkeleton rows={1} />
      </div>
    </div>
  );
}
