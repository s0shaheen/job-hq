"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<[href: string, label: string]> = [
  ["/queue", "Queue"],
  ["/pipeline", "Pipeline"],
  ["/health", "Health"],
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className={pathname === href ? "active" : undefined}
          aria-current={pathname === href ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
