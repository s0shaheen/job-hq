import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ds";
import { cn } from "@/lib/utils";
import { SETTINGS_SECTIONS, type SettingsSectionKey } from "./sections";

/**
 * The Settings frame: a 200px section rail beside a 640px content column.
 *
 * Ported from `templates/settings/Settings.dc.html`, which draws a 24px page
 * pad, a `PageHeader` reading "Settings", then `display:flex; gap:32px` with
 * `flex:0 0 200px` for the rail and `flex:1; min-width:0; max-width:640px` for
 * the content. Rail rows are 32px tall, 12px of horizontal padding, 6px radius;
 * the current one is `var(--selected)` at weight 500 and the rest are
 * `var(--text-2)` on transparent with a `var(--raised)` hover.
 *
 * THREE DEVIATIONS FROM THE TEMPLATE, all of them consequences of the template
 * being a static mock:
 *
 * 1. **Links, not buttons.** The mock's rail rows are `<button onClick>` because
 *    a mock has no router. These are real destinations with real URLs, so they
 *    are anchors carrying `aria-current="page"`. A button that navigates is a
 *    link a keyboard user cannot open in a new tab and a screen reader does not
 *    announce as a destination.
 * 2. **The rail stacks below `md`.** The mock has one viewport. 200px of rail
 *    plus a 32px gutter leaves 48px of content at 280px, so below `md` the rail
 *    becomes one horizontally scrolling row — the same shape, and the same
 *    reason, as `AppNav` above it. Everything past the viewport scrolls INSIDE
 *    the rail, so the page never moves sideways. `tests/e2e/settings.spec.ts`
 *    measures that at 280px.
 * 3. **No `data-bounded-frame`.** Settings is a form column that grows past one
 *    screen and has no virtualizer, so it keeps the shell's default frame where
 *    the DOCUMENT scrolls. Opting into the bounded frame here would repeat #121:
 *    on a phone it takes document scrolling away and pins the section's one
 *    primary action under a bottom-anchored toast.
 */
export function SettingsShell({
  active,
  children,
}: {
  active: SettingsSectionKey;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 p-4 md:p-6">
      {/* No subtitle. 01 §4 allows one only when it carries scope, a count or a
          last-updated time, and Settings has none of the three — a decorative
          line here is the exact thing `PageHeader` refuses. */}
      <PageHeader title="Settings" />

      <div className="mt-4 flex min-w-0 flex-col gap-4 md:flex-row md:items-start md:gap-8">
        <nav
          aria-label="Settings sections"
          data-testid="settings-rail"
          className={
            "flex shrink-0 gap-0.5 overflow-x-auto " +
            "md:w-50 md:flex-col md:overflow-x-visible"
          }
        >
          {SETTINGS_SECTIONS.map((section) => {
            const current = section.key === active;
            return (
              <Link
                key={section.key}
                href={section.href}
                data-testid={`settings-rail-${section.key}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-8 shrink-0 items-center rounded-md px-3 whitespace-nowrap no-underline",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  current
                    ? "bg-selected font-medium text-text"
                    : "text-text-2 hover:bg-raised",
                )}
              >
                {section.name}
              </Link>
            );
          })}
        </nav>

        {/* 640px, the design's number, and `min-w-0` so a long unbroken string
            inside a section shrinks the column rather than widening the page. */}
        <div className="min-w-0 flex-1 md:max-w-160">{children}</div>
      </div>
    </div>
  );
}

/**
 * A section's heading block: title, and the sentence stating its save semantics.
 *
 * The sentence is not decoration and is not optional. 06 §A's guardrail is that
 * save semantics DIFFER by section — Profile & search commits explicitly,
 * everything else autosaves — and that each section says which it is. A person
 * who has to discover that by pressing something has been told nothing.
 */
export function SectionHeading({
  title,
  saveNote,
  status,
}: {
  title: string;
  saveNote?: string;
  /** The autosaved sections' quiet tick, rendered by the client control. */
  status?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base leading-6 font-semibold text-text">{title}</h2>
        {status}
      </div>
      {saveNote ? <p className="mt-1 text-sm text-muted">{saveNote}</p> : null}
    </div>
  );
}
