/**
 * The Settings section rail, as one list.
 *
 * Five sections in a fixed order, taken verbatim from `Settings.dc.html`'s
 * `rail` array: Profile & search, Preferences, Data, Account, Plan & billing.
 * The order is the design's and is not sorted, derived, or grown here — an
 * addition is a design change, not a code change.
 *
 * A LIST RATHER THAN FIVE HARDCODED LINKS, because three things have to agree
 * about it and only one of them is the rail: the rail renders it, every section
 * page names its own key from it, and `tests/e2e/settings.spec.ts` walks it to
 * prove each href resolves. A sixth section added to the rail with no page
 * behind it is the failure `routing.spec.ts` exists for, one surface down.
 *
 * Settings is NOT one of the five rail destinations in `components/ds/app-shell.tsx`
 * (Today, Jobs, Applications, Autopilot, Coverage). It is a separate place, and
 * this is its own second-level rail.
 */

export type SettingsSectionKey = "profile" | "preferences" | "data" | "account" | "plan";

export type SettingsSection = {
  readonly key: SettingsSectionKey;
  /** Exactly the design's label. Sentence case, ampersand as drawn. */
  readonly name: string;
  readonly href: string;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // `/settings` itself, not `/settings/profile`. The queue's why-popover deep
  // links to `/settings#metros` and friends, `routing.spec.ts` derives that list
  // from `reasonSetting()`, and every one of those fragments has to keep landing
  // on a page that carries the anchor. Moving Profile & search to a child route
  // would break every one of them at once.
  { key: "profile", name: "Profile & search", href: "/settings" },
  { key: "preferences", name: "Preferences", href: "/settings/preferences" },
  { key: "data", name: "Data", href: "/settings/data" },
  { key: "account", name: "Account", href: "/settings/account" },
  { key: "plan", name: "Plan & billing", href: "/settings/plan" },
];
