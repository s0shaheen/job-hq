import type { ReactNode } from "react";
import Link from "next/link";

/**
 * The entry column, ported from `templates/auth/Auth.dc.html`.
 *
 * One 360px column on the page background, 96px from the top and 24px in from
 * each side, holding a 24px rounded mark with the monogram, the product name at
 * 14/20 weight 600, the screen, and a quiet legal line 48px below it. Every auth
 * screen the design authors is this frame with different contents, and
 * `min-height:100vh` becomes `min-h-dvh` for the phone's shrinking chrome.
 *
 * ZERO MARKETING, which is 06 §C's rule and not a preference. There is no
 * tagline, no illustration, no split screen and no "Welcome back". The line the
 * old login page carried ("The family job-search cockpit. Sign in to see your
 * queue.") is gone: it is a decorative subtitle on the one surface where the
 * design explicitly forbids one, and it described a family tool rather than the
 * product this is becoming.
 *
 * OUTSIDE THE APP SHELL. The rail, the badge and the toaster all belong to a
 * signed-in session; an entry surface has none, and 03 §10 puts Auth and
 * Onboarding outside the frame for that reason.
 *
 * The legal line is DEV-011: `/terms` and `/privacy` render a page that says
 * their content is not published yet. Rendering the links against pages that
 * say so is the visible version of the gap; dropping them until ADR-012 lands
 * would remove the one part of this surface a reviewer would notice missing.
 */
export function AuthColumn({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <main
      data-testid={testId}
      className="flex min-h-dvh flex-col items-center bg-bg px-6 pt-24 pb-12 text-sm text-text"
    >
      <div className="w-90 max-w-full">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-raised text-2xs font-semibold text-text-2"
          >
            JH
          </span>
          <span className="text-sm leading-5 font-semibold text-text">Job HQ</span>
        </div>

        {children}

        {/* `min-h-6` and vertical padding on each link, pulled back with a
            negative margin so the 48px gap the design draws is unchanged.
            The design's legal line is 12/16 text, which is a 16px target; these
            are a footer nav rather than links inside a sentence, so SC 2.5.8's
            inline exception does not cover them and 24px is the floor. Nothing
            in this repo measures target size, so this is reasoned by hand. */}
        <div className="mt-11 -mb-1 flex gap-4 text-xs">
          <Link
            href="/terms"
            className="inline-flex min-h-6 items-center text-muted no-underline hover:underline"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="inline-flex min-h-6 items-center text-muted no-underline hover:underline"
          >
            Privacy
          </Link>
        </div>
      </div>
    </main>
  );
}

/** The screen title: 20/28 weight 600, 32px below the mark. */
export function AuthTitle({ children }: { children: ReactNode }) {
  return <h1 className="mt-8 text-xl leading-7 font-semibold text-text">{children}</h1>;
}

/**
 * Google's button, in Google's rendering.
 *
 * 40px tall, full width, a 1px `#747775` border on white, `#1f1f1f` label at
 * 14px weight 500, 4px radius, the four-colour mark at 18px, and the exact
 * string "Continue with Google". Those are Google's identity-branding values and
 * they are hardcoded rather than tokenised on purpose: 06 §C says the button is
 * never restyled to the accent, and a token would let a palette change quietly
 * restyle somebody else's trademark.
 *
 * That is also why it is the one place in this app with raw hex. The anti-slop
 * sweep reads computed styles, not tokens, so it is unaffected; what would break
 * the rule is a gradient or a radius over 12px, and this has neither.
 */
export function GoogleButton({
  label,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={
        "mt-6 flex h-10 w-full items-center justify-center gap-2.5 rounded border " +
        "border-[#747775] bg-white text-sm font-medium text-[#1f1f1f] " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
        "disabled:cursor-default"
      }
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        />
        <path
          fill="#FBBC05"
          d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        />
      </svg>
      {label}
    </button>
  );
}
