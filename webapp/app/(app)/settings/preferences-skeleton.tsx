/**
 * The Preferences skeleton — `profile-skeleton.tsx`'s idiom, drawn to this
 * section's shape.
 *
 * Band for band it is the real section: a title bar beside nothing (the tick
 * only renders after a save), the autosave sentence, then the five control rows
 * `Settings.dc.html` draws — four label-over-select rows at the selects' own
 * 200px, the fourth with its help line, and the switch row with its title and
 * description. Those are the shapes the loaded controls land in, which is
 * 04 §5's requirement for this state — a "content-shaped skeleton, no layout
 * jump or indefinite spinner".
 *
 * Rendered as a `Suspense` fallback INSIDE `SettingsShell`, never as a route
 * `loading.tsx`, for the reason the profile section's boundary sits where it
 * does: the rail is the one control that still works while this read is slow,
 * and a route-level fallback would blank it.
 *
 * `aria-hidden` plus one live region: a screen reader gets "Loading your
 * preferences" once, not eleven unlabelled boxes.
 */
function Bar({ className }: { className: string }) {
  return <span className={`block rounded bg-raised ${className}`} />;
}

export function PreferencesSkeleton() {
  return (
    <div data-testid="preferences-skeleton" className="min-w-0">
      <p className="sr-only" role="status">
        Loading your preferences
      </p>
      <div aria-hidden>
        <div className="flex flex-col gap-2">
          <Bar className="h-4 w-28" />
          <Bar className="h-3 w-56 max-w-full" />
        </div>

        <div className="mt-6 flex flex-col gap-4">
          {/* Density, Type size, Theme: label over a 200px select. */}
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-col gap-1">
              <Bar className="h-3 w-16" />
              <Bar className="h-8 w-50 max-w-full rounded-md" />
            </div>
          ))}

          {/* Landing view, the one select with its own help line below. */}
          <div className="flex flex-col gap-1">
            <Bar className="h-3 w-20" />
            <Bar className="h-8 w-50 max-w-full rounded-md" />
            <Bar className="h-3 w-44 max-w-full" />
          </div>

          {/* The keyboard-hints switch: track, then title and description. */}
          <div className="flex gap-3">
            <Bar className="h-6 w-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Bar className="h-3 w-24" />
              <Bar className="h-3 w-64 max-w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
