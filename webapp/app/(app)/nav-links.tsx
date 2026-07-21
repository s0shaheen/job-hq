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
 * Sidebar navigation. A sidebar rather than horizontal tabs because six
 * sections do not fit across a top bar at 1280px without truncating, and
 * truncated nav is how people stop finding features.
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
          "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          active
            ? "bg-accent-subtle font-semibold text-text"
            : "text-text-2 hover:bg-raised",
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
        {typeof count === "number" && count > 0 ? (
          <span className="tabular ml-auto text-2xs text-muted">{count}</span>
        ) : null}
      </Link>
    );
  };

  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {PRIMARY.map((n) => item(n.href, n.label, n.icon))}
      <p className="px-2.5 pt-4 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted">
        Account
      </p>
      {SECONDARY.map((n) => item(n.href, n.label, n.icon))}
    </nav>
  );
}
