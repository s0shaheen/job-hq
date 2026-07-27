import { Clock, Star, X } from "lucide-react";
import { Button, Kbd } from "hq-webapp";

/**
 * Kbd's whole docstring is about one bug: a hint hard-coded to `text-muted`
 * read fine on the page background and vanished on the accent-filled primary
 * button — the `i` on "Interested" was invisible while `x` and `s` were fine.
 * The fix was `currentColor` and no opacity, so the first card here is that
 * exact comparison: the same hint on all four button surfaces plus plain text.
 */

const row: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
};

/**
 * The regression card. Every hint inherits its surface's text colour, so it is
 * exactly as legible as the label beside it — including on the filled primary,
 * where a fixed token disappears.
 */
export function OnEverySurface() {
  return (
    <div style={row}>
      <Button variant="primary">
        <Star aria-hidden="true" className="size-3.5" /> Interested <Kbd>i</Kbd>
      </Button>
      <Button variant="secondary">
        <X aria-hidden="true" className="size-3.5" /> Pass <Kbd>x</Kbd>
      </Button>
      <Button variant="ghost">
        <Clock aria-hidden="true" className="size-3.5" /> Later <Kbd>s</Kbd>
      </Button>
      <Button variant="danger">
        Delete <Kbd>⌫</Kbd>
      </Button>
      <span className="text-sm text-text-2">
        on plain text <Kbd>o</Kbd>
      </span>
    </div>
  );
}

/** The queue's footer, verbatim — hints inline in a sentence. */
export function InHelpText() {
  return (
    <p className="max-w-md text-xs text-muted">
      <Kbd className="ml-0">j</Kbd> <Kbd>k</Kbd> move · <Kbd>i</Kbd> interested ·{" "}
      <Kbd>x</Kbd> pass · <Kbd>s</Kbd> later · <Kbd>o</Kbd> open. Every decision can be
      undone for a few seconds.
    </p>
  );
}

/** Modifiers and named keys, as the grid and the export dialog print them. */
export function ModifiersAndNamedKeys() {
  return (
    <p className="max-w-md text-xs text-muted">
      <Kbd className="ml-0">⌘E</Kbd> export · <Kbd>⌘C</Kbd> copy · <Kbd>⇧j</Kbd>{" "}
      <Kbd>⇧k</Kbd> extend · <Kbd>Space</Kbd> select · <Kbd>Esc</Kbd> clear ·{" "}
      <Kbd>?</Kbd> why
    </p>
  );
}
