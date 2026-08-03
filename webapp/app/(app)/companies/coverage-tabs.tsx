"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The Coverage console's three tabs (`Coverage.dc.html` lines 17-22).
 *
 * A PLAIN tab strip, not `SavedViewTabs`. The handoff's open question 2 asks
 * exactly this and answers it: `SavedViewTabs` is Jobs' named-query construct,
 * and reusing it here would say "these are saved queries over one collection"
 * about three different collections.
 *
 * They are LINKS, not buttons. The template is one mock page with client state,
 * but this app already has three routes carrying these three collections, and
 * each is deep-linkable, reloadable and bookmarked. Turning them into panes of a
 * single route is a routing change, not a presentation one, and the redirect of
 * `/health` into a `/coverage` console is step 4 of the 07 section 5 order —
 * this branch cuts over the surfaces, not the addresses.
 *
 * `Connections` points at `/connections`, which is the find-intro surface's
 * route and is NOT cut over on this branch. So the strip renders on the two
 * routes this surface owns and the third tab is a plain link out; a reader who
 * follows it lands on the un-redesigned surface without the strip. Recorded as a
 * deviation (DEV-COV-02 in `07-decisions-assumptions-risks.md`) rather than
 * fixed here, because giving `/connections` the strip
 * means editing a surface this packet does not own.
 */
const TABS: readonly { label: string; href: string }[] = [
  { label: "Companies", href: "/companies" },
  { label: "Connections", href: "/connections" },
  { label: "Activity", href: "/health" },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

export default function CoverageTabs() {
  const pathname = usePathname() ?? "";
  return (
    // The strip SCROLLS INSIDE ITSELF. Three tabs plus the rail's gutters do not
    // fit a 280px viewport, and a nav that pushes the page sideways is the
    // release gate every surface shares — `layout.spec.ts` and this surface's own
    // 280px test both measure painted geometry, not intent. `shrink-0` on the
    // links so they scroll rather than squashing into unreadable slivers.
    <nav
      aria-label="Coverage"
      data-testid="coverage-tabs"
      className="mt-4 flex gap-0.5 overflow-x-auto"
    >
      {TABS.map(({ label, href }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center rounded-md px-3 text-sm no-underline",
              "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
              active
                ? "bg-selected font-medium text-text"
                : "text-text-2 hover:bg-raised",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
