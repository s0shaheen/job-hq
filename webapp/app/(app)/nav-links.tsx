"use client";

import { Inbox, LayoutGrid, ListChecks, Plus, Activity, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const PRIMARY = [
  { href: "/queue", label: "Triage", icon: Inbox },
  { href: "/jobs", label: "Jobs", icon: LayoutGrid },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  { href: "/add", label: "Add", icon: Plus },
] as const;

const SECONDARY = [
  { href: "/health", label: "Health", icon: Activity },
  { href: "/settings", label: "Search profile", icon: Settings },
] as const;

export type NavCounts = Partial<Record<string, number>>;

/**
 * Navigation: a sidebar on desktop, a horizontal strip on phones.
 *
 * A sidebar rather than top tabs on wide screens because six sections do not
 * fit across a top bar at 1280px without truncating, and truncated nav is how
 * people stop finding features.
 *
 * On a phone the same vertical list is wrong for a different reason: six
 * stacked rows filled the entire first screen, so the first thing below the
 * fold was the actual job. Below `lg` the list becomes one scrollable row —
 * still every destination visible, still no hamburger, but the content starts
 * near the top where it belongs.
 */
export default function NavLinks({ counts = {} }: { counts?: NavCounts }) {
  const pathname = usePathname();

  const item = (href: string, label: string, Icon: typeof Inbox) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    const count = counts[href];
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
          active
            ? "bg-accent-subtle font-semibold text-text"
            : "text-text-2 hover:bg-raised",
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
        {typeof count === "number" && count > 0 ? (
          // ml-auto pins the count to the right edge of a sidebar row; in the
          // horizontal strip there is no right edge to pin to.
          <span className="tabular ml-1 text-2xs text-muted lg:ml-auto">{count}</span>
        ) : null}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Sections"
      className="flex gap-0.5 overflow-x-auto lg:flex-col lg:overflow-x-visible"
    >
      {PRIMARY.map((n) => item(n.href, n.label, n.icon))}
      {/* A group heading only reads as a heading in a vertical list. */}
      <p className="hidden px-2.5 pt-4 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted lg:block">
        Account
      </p>
      {SECONDARY.map((n) => item(n.href, n.label, n.icon))}
    </nav>
  );
}
