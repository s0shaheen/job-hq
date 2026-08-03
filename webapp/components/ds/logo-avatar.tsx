"use client";

import * as React from "react";
import { logoSources } from "@/lib/logo";
import { cn } from "@/lib/utils";

export type LogoAvatarSize = 16 | 20 | 32;

const sizeClasses: Record<LogoAvatarSize, string> = {
  16: "size-4",
  20: "size-5",
  32: "size-8",
};

/**
 * Deterministic two-letter monogram derived from the company name. Never
 * random hues, never a colour keyed off a hash of the name: the background is
 * the neutral `bg-raised` for every company, so a logo that fails to load
 * degrades into something quiet rather than into confetti.
 */
export function monogram(name: string): string {
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : trimmed.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A company logo, with the source ladder from 01 section 7: logo.dev by domain,
 * then Google's favicon, then the monogram. `lib/logo.ts` owns the URLs; this
 * component owns which rung is showing.
 *
 * It takes a `domain`, not a `src`. Walking the ladder is the component's job
 * because only the component sees the image fail, and a caller that had to
 * pass `src` would end up reimplementing the fallback at every call site.
 *
 * **Today both rungs are usually absent, and that is the intended state.**
 * `company.domain` arrives with `feat/company-domain-logos` and
 * `NEXT_PUBLIC_LOGO_DEV_KEY` is not set anywhere yet, so with no domain and/or
 * no key `logoSources` returns a shorter ladder (or an empty one) and this
 * renders the monogram. This branch is green standalone: nothing here needs
 * either of those to land first.
 *
 * `alt=""`: the logo is decorative because a company name always sits beside
 * it (01 section 7). Announcing "Ramp logo" next to the word "Ramp" is noise.
 */
export function LogoAvatar({
  name,
  domain,
  size = 16,
  className,
}: {
  name: string;
  domain?: string | null;
  size?: LogoAvatarSize;
  className?: string;
}) {
  const sources = React.useMemo(
    // The key is a build-time constant, so `domain` is the only reactive input.
    () => logoSources(domain, process.env.NEXT_PUBLIC_LOGO_DEV_KEY),
    [domain],
  );

  const [rung, setRung] = React.useState(0);
  // Reset during render rather than in an effect: rows recycle in a virtualized
  // grid, so the same mounted element is handed a different company, and a rung
  // left over from the previous one would show that company's fallback.
  const [seenDomain, setSeenDomain] = React.useState(domain);
  if (seenDomain !== domain) {
    setSeenDomain(domain);
    setRung(0);
  }

  const src = rung < sources.length ? sources[rung] : null;

  /**
   * The rung the `onError` prop cannot see.
   *
   * A row rendered on the SERVER arrives as HTML, and the browser starts
   * fetching its `<img>` while the document is still parsing — long before
   * React hydrates and attaches this component's handlers. If that fetch fails
   * in the gap, the `error` event has already fired and been dropped: the
   * `onError` below never runs, the rung never advances, and the cell parks on
   * the browser's broken-image glyph forever.
   *
   * Jobs never showed it because its rows are virtualized and therefore mount
   * after hydration; Today server-renders its list, which is what surfaced
   * this. So on mount, ask the element what already happened — a complete image
   * with no intrinsic width IS a failed one — and advance the ladder from
   * there.
   */
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  // Latched per src, because StrictMode runs every effect TWICE in development
  // (`next.config.ts` sets `reactStrictMode: true`). Unlatched, one failed
  // image advanced the rung by two and skipped a perfectly good rung — under
  // `next dev` a logo.dev failure would jump straight past Google's favicon to
  // the monogram. The ref is not state: re-rendering because we noticed a
  // failure is the point, re-rendering because we noticed it twice is the bug.
  const probedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (src === null || probedRef.current === src) return;
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) {
      probedRef.current = src;
      setRung((r) => r + 1);
    }
  }, [src]);

  return (
    <span
      // DECORATIVE IN BOTH BRANCHES, and it has to be said here rather than only
      // on the image. `alt=""` already hides the logo for the reason below —
      // the company name always sits beside it — but that attribute does
      // nothing for the MONOGRAM fallback, which is real text. Without this a
      // screen reader reads every row of the Company column as "R A Ramp", and
      // the fallback is what renders for every company with no domain.
      aria-hidden
      className={cn(
        sizeClasses[size],
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-raised",
        className,
      )}
    >
      {src ? (
        <img
          // Keyed by URL so a failed rung's <img> is replaced rather than
          // reused; a reused element can keep the broken-image state.
          key={src}
          ref={imgRef}
          src={src}
          alt=""
          className="block size-full object-cover"
          // Past the last rung this stops advancing and the monogram shows.
          // There is ALWAYS a rung after the last one, so a domain that 404s on
          // both services degrades to the monogram rather than to the browser's
          // broken-image glyph.
          onError={() => setRung((r) => r + 1)}
        />
      ) : (
        // A company with no name yields no letters, and that is a real row: the
        // universe carries slug-only entries because Common Crawl mines boards,
        // not names. It renders as the bare neutral square — which keeps the
        // column's 16px rhythm and says nothing, rather than inventing initials
        // or collapsing the cell and misaligning every row below it.
        <span className={cn("font-medium text-text-2", size === 32 ? "text-xs" : "text-2xs")}>
          {monogram(name)}
        </span>
      )}
    </span>
  );
}
