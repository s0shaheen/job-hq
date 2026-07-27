"use client";

import {
  Inbox,
  LayoutGrid,
  ListChecks,
  Building2,
  Users,
  Plus,
  Upload,
  Activity,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Inbox;
  /**
   * The destination is an honest placeholder, not a live surface. Marked in
   * the nav — not discovered on arrival — because these three links spent a
   * whole phase returning a bare 404 while looking exactly like the live
   * ones, and a user learns "half this app is dead" from one such click. The
   * links stay links (not removed, not disabled): the nav is the product's
   * map, and each placeholder says where that job happens today. Delete the
   * flag when the surface's phase ships.
   */
  soon?: true;
};

const PRIMARY: readonly NavItem[] = [
  { href: "/queue", label: "Triage", icon: Inbox },
  { href: "/jobs", label: "Jobs", icon: LayoutGrid },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  // Not marked `soon`: /companies is a live surface. It sits after Pipeline because
  // it is upstream plumbing — deciding which companies get watched — and the three
  // above it are the daily work.
  { href: "/companies", label: "Companies", icon: Building2 },
  // Live, so no `soon` flag. It sits last of the primary items because it is
  // something you do once when you arrive and rarely again — the three above it
  // are the daily work, and /companies is the plumbing behind them.
  { href: "/import", label: "Import", icon: Upload },
  // Live since the referral finder's first two steps. Beside /import because it
  // is the same gesture — a file you already have, brought in once — and above
  // /add so the two live import surfaces sit together.
  { href: "/connections", label: "Connections", icon: Users },
  { href: "/add", label: "Add", icon: Plus, soon: true },
];

const SECONDARY: readonly NavItem[] = [
  { href: "/health", label: "Health", icon: Activity },
  // Live since P10: the profile is editable here, with a dry run in front of
  // the save. It was flagged `soon` while the page was read-only anchors.
  { href: "/settings", label: "Search profile", icon: Settings },
];

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

  const item = ({ href, label, icon: Icon, soon }: NavItem) => {
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
        {soon ? (
          // No colour class and no opacity, on purpose: the chip inherits
          // currentColor, so it is exactly as legible as the label beside it
          // on every background this row can have — the Kbd lessons (matrix
          // rows 23 and 30). De-emphasis comes from size and border alone.
          <span className="rounded border border-border-strong px-1 text-2xs leading-4">
            Soon
          </span>
        ) : null}
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
      {PRIMARY.map(item)}
      {/* A group heading only reads as a heading in a vertical list. */}
      <p className="hidden px-2.5 pt-4 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted lg:block">
        Account
      </p>
      {SECONDARY.map(item)}
    </nav>
  );
}
