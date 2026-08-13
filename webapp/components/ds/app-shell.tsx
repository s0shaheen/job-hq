"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, Briefcase, Inbox, Send, SlidersHorizontal, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { monogram } from "./logo-avatar";

/**
 * The app frame every surface shares: a 224px left rail and a 24px content
 * gutter (01 section 4).
 *
 * Ported from the design seed's `AppShell.tsx`, which is a static mock with no
 * router and no auth. The deviations from it are all one of those two facts,
 * and each is marked below.
 */
export type NavDestination = "Today" | "Jobs" | "Applications" | "Autopilot" | "Coverage";

type Destination = { label: NavDestination; href: string; icon: LucideIcon };

/**
 * Five destinations, fixed order, down from nine (03 section 1).
 *
 * Applications points at `/pipeline` on purpose. Only Jobs cuts over in this
 * step; moving the route is the Applications cutover's job (07 section 5,
 * step 3), and a rename here would break every link and bookmark for a surface
 * this branch does not otherwise touch. The LABEL is already "Applications"
 * because the dictionary is a display concern — the word a person reads and
 * the path a router matches are allowed to disagree, and this is the one place
 * where they briefly do.
 *
 * Today points at `/queue` for the same reason, in the other direction. The
 * Today surface IS the queue chassis — it is where the decision machinery, the
 * session-expiry journey and twenty inbound links already live, and
 * moving the route would be a redirect on the app's most-linked path for no
 * gain a reader can see. `/today` held a placeholder until this cutover and now
 * redirects here, so a bookmark of it still lands on the built surface.
 */
const DESTINATIONS: readonly Destination[] = [
  { label: "Today", href: "/queue", icon: Inbox },
  { label: "Jobs", href: "/jobs", icon: Briefcase },
  { label: "Applications", href: "/pipeline", icon: Send },
  { label: "Autopilot", href: "/autopilot", icon: Zap },
  { label: "Coverage", href: "/coverage", icon: Activity },
];

const SETTINGS_HREF = "/settings";

/** The active-row rule, copied from `app/(app)/nav-links.tsx` so both navs
 *  agree during the cutover: a destination owns its subtree. */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

const rowClasses =
  "flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 whitespace-nowrap no-underline " +
  "focus-visible:outline-2 focus-visible:outline-ring";

function NavRow({
  href,
  label,
  icon: Icon,
  active,
  badge,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        rowClasses,
        active ? "bg-selected font-medium text-text" : "text-text-2 hover:bg-surface",
      )}
    >
      <Icon size={16} strokeWidth={1.75} className="text-muted" aria-hidden />
      <span className="flex-1">{label}</span>
      {badge !== undefined && badge > 0 ? (
        // Today carries the ONLY nav badge, the total of pending decisions
        // (03 section 1). Plain muted text, right-aligned, never an accent
        // pill: a coloured count on a nav row is a notification, and this is
        // a quantity of work that is simply there. No other destination shows
        // a count, which is what makes this one mean something.
        <span className="text-xs tabular-nums text-muted">{badge}</span>
      ) : null}
    </Link>
  );
}

export function AppNav({
  active,
  badge = 0,
  userName,
  userInitials,
  userAction,
}: {
  /** Optional: the rail derives the active row from the router. See `AppShell`. */
  active?: NavDestination;
  badge?: number;
  userName?: string;
  userInitials?: string;
  /** Rendered under the user chip. Carries sign-out; see `AppShell`. */
  userAction?: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const initials = userName ? (userInitials ?? monogram(userName)) : undefined;

  return (
    <nav
      aria-label="Sections"
      /**
       * Below `lg` the rail becomes one horizontally scrolling row, which is
       * what `nav-links.tsx` already does and why it does it: five stacked
       * rows fill a phone's first screen, so the first thing below the fold is
       * the actual job. Everything past the viewport scrolls INSIDE this
       * element, so the page itself never moves sideways at 320px
       * (`tests/e2e/layout.spec.ts` measures that). The seed has one layout
       * because a static mock has one viewport.
       */
      className={
        "flex shrink-0 gap-0.5 overflow-x-auto border-b border-border bg-raised px-2 py-3 text-sm " +
        "lg:sticky lg:top-0 lg:h-dvh lg:w-56 lg:flex-col lg:gap-0 lg:overflow-x-visible " +
        "lg:border-r lg:border-b-0"
      }
    >
      {/*
        The seed's search pill with its ⌘K hint is deliberately not here. The
        command palette is a named, unbuilt component (03 section 10), so the
        pill would be a control that opens nothing and a key hint for a
        shortcut nothing listens to — copy promising unwired behaviour, which
        is the exact defect this repo has already recorded once. It comes back
        with the palette, in one commit with it.

        The seed carries no wordmark either, and none is invented here.
      */}
      {DESTINATIONS.map(({ label, href, icon }) => (
        <NavRow
          key={label}
          href={href}
          label={label}
          icon={icon}
          active={active ? label === active : isActive(pathname, href)}
          badge={label === "Today" ? badge : undefined}
        />
      ))}

      <div className="flex-1" />

      {/* Settings sits below the five and outside `NavDestination`: it is not
          one of the product's rooms, it is where their behaviour is set. */}
      <NavRow
        href={SETTINGS_HREF}
        label="Settings"
        icon={SlidersHorizontal}
        active={isActive(pathname, SETTINGS_HREF)}
      />

      {userName ? (
        <div className="mt-1 flex min-w-0 shrink-0 items-center gap-2 px-2 py-1.5">
          <span
            aria-hidden
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-raised text-2xs font-medium text-text-2"
          >
            {initials}
          </span>
          <span className="truncate text-text-2" title={userName}>
            {userName}
          </span>
        </div>
      ) : null}
      {/*
        No "Alex Tran" fallback. The seed ships one so the mock has something to
        render; here a name nobody signed in as is a fixture presented as real
        data, so an absent user renders nothing at all.
      */}

      {userAction ? <div className="shrink-0 px-1">{userAction}</div> : null}
    </nav>
  );
}

/**
 * The frame.
 *
 * `active` is OPTIONAL here, unlike the seed's required prop. The seed needs it
 * because a static mock has no router; this app does, so `AppNav` reads
 * `usePathname()` and the layout that renders the shell — a server component
 * with no pathname of its own — does not have to invent one. Passing `active`
 * still wins, for a surface that owns a route it does not sit at.
 *
 * `userAction` has no seed counterpart. The seed has no auth, and the frame it
 * replaces holds the app's only sign-out control; dropping that behind a flag
 * would be a functional regression dressed as a port.
 */
export function AppShell({
  active,
  badge = 0,
  userName,
  userInitials,
  userAction,
  children,
}: {
  active?: NavDestination;
  badge?: number;
  userName?: string;
  userInitials?: string;
  userAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    /**
     * Two frames, and which one a surface gets is the surface's own call.
     *
     * DEFAULT (no opt-in): `min-h-dvh`, nothing clipped, and the DOCUMENT is
     * the scroller — the frame this app had before the redesign, and the one
     * every un-cut-over surface was authored and regression-tested against.
     *
     * BOUNDED (`data-bounded-frame` anywhere inside): `h-dvh` with `main` as
     * the only scroller. That is row 309's fix and it is real — a virtualizer
     * whose scroll parent grows with its own 5,000-row canvas treats every row
     * as visible and defeats its DOM bound. But it is JOBS' requirement, and
     * the first cutover applied it to the whole app, which took document
     * scrolling away from twelve surfaces that never asked for it. Measured on
     * a Pixel 7 (412x839): `document.documentElement` went to
     * scrollHeight === clientHeight === 839, maxScroll 0, on /companies/add,
     * /connections, /settings, /queue and /jobs alike. On /companies/add that
     * left the submit button pinned at y=807-839 under a bottom-anchored toast
     * with no page scroll to lift it clear, which is the whole of #121's
     * mobile regression; `companies.spec.ts` "a phone can reach the submit
     * button while the previous toast is up" is what caught it.
     *
     * `:has()` rather than a prop, because the layout that renders this shell
     * is a server component with no pathname and the surfaces below it are the
     * things that know their own shape. It resolves during the first paint from
     * server HTML, so there is no unbounded frame flashing before hydration
     * corrects it — which a context or an effect would both have.
     */
    <div
      className={
        "flex min-h-dvh flex-col bg-bg font-sans text-sm text-text lg:flex-row lg:items-stretch " +
        "has-[[data-bounded-frame]]:h-dvh has-[[data-bounded-frame]]:overflow-hidden"
      }
    >
      <AppNav
        active={active}
        badge={badge}
        userName={userName}
        userInitials={userInitials}
        userAction={userAction}
      />
      {/*
        `main` carries NO gutter, and the seed's `p-6` does not survive the port.

        The seed has one surface, so putting the 24px gutter on the frame costs
        it nothing. This app's surfaces are not all one shape: Jobs runs a detail
        pane flush to the right edge as a flex SIBLING of its content column (the
        owner's authored composition), and a gutter on `main` would inset that
        pane, float it in the middle of the page, and leave a stripe of page
        background between it and the window.

        So the frame provides the rail and the surfaces own their content box —
        which is what every route in this app already did before the redesign.
        The gutter itself is unchanged: 24px, dropping to 16px below 768px
        (01 section 4), applied by each surface as `p-4 md:p-6`.
      */}
      <main
        className={
          "flex min-h-0 min-w-0 flex-1 flex-col " +
          // Paired with the root above: `main` scrolls only when the frame is
          // bounded. Under the default frame it must NOT, or the surface gets
          // two nested scrollers and the outer one never moves.
          "has-[[data-bounded-frame]]:overflow-y-auto"
        }
      >
        {children}
      </main>
    </div>
  );
}
