/**
 * The Profile & search skeleton, ported from `Settings.dc.html`'s
 * "Settings, Profile loading" frame.
 *
 * The design draws it band for band: a 160px title bar over a 320px subtitle,
 * two rows of a flexible field beside a fixed one (160px), a short field with a
 * 120px control, a 96px label, a 72px card, and a 112px button. Those are the
 * shapes of the real section, which is 04 §5's requirement for this state — a
 * "content-shaped skeleton, no layout jump or indefinite spinner". A centred
 * spinner would pass an eye test and fail the standard.
 *
 * Rendered as a `Suspense` fallback on the profile page rather than as a route
 * `loading.tsx`, because a `loading.tsx` in this segment would also cover
 * `/settings/answers` and the four sibling sections — which are different
 * shapes, so it would be exactly the layout jump this skeleton exists to
 * prevent. The rail and the page header are outside it and paint immediately.
 *
 * `aria-hidden` plus one live region: a screen reader gets "Loading your
 * profile" once, not sixteen unlabelled boxes.
 */
function Bar({ className }: { className: string }) {
  return <span className={`block rounded bg-raised ${className}`} />;
}

export function ProfileSkeleton() {
  return (
    <div data-testid="settings-skeleton" className="mt-6 min-w-0">
      <p className="sr-only" role="status">
        Loading your profile
      </p>
      <div aria-hidden className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Bar className="h-4 w-40" />
          <Bar className="h-3 w-80 max-w-full" />
        </div>

        {[0, 1].map((row) => (
          <div key={row} className="flex flex-wrap gap-3">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <Bar className="h-3 w-16" />
              <Bar className="h-8 w-full rounded-md" />
            </span>
            <span className="flex w-40 flex-col gap-1">
              <Bar className="h-3 w-16" />
              <Bar className="h-8 w-full rounded-md" />
            </span>
          </div>
        ))}

        <div className="flex flex-col gap-1">
          <Bar className="h-3 w-14" />
          <Bar className="h-8 w-30 rounded-md" />
        </div>

        <Bar className="h-5 w-24" />
        <Bar className="h-18 w-full rounded-lg" />
        <Bar className="h-8 w-28 rounded-md" />
      </div>
    </div>
  );
}
