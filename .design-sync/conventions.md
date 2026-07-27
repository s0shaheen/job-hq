# Building with the Job HQ design system

React + Tailwind v4 utilities bound to CSS tokens. No theme provider, no wrapper — components
work anywhere. Two setup rules only: mount `<Toaster />` once per app (then call the exported
`toast(...)` — use the export on this bundle, never a second sonner instance), and overlays
are Radix: `DialogContent` goes inside `Dialog` + `DialogTrigger`; `ProvenanceChip` anchors its
own `Popover`. Dark mode is a `.dark` class on the root — never write `dark:` utilities; the
tokens flip themselves.

## The styling vocabulary (use these, don't invent)

- Surfaces: `bg-bg` (page) · `bg-surface` (cards/panels) · `bg-raised` (hover/menus) ·
  `bg-selected` (selected rows).
- Text: `text-text` (primary) · `text-text-2` (secondary) · `text-muted` (annotations).
- Borders: `border-border`, `border-border-strong`; radius `rounded-sm|md|lg|xl` — never bare
  `rounded`.
- States: `ok` / `warn` / `danger` / `info` (+ `accent`), each as `text-X` on `bg-X-subtle`.
  Color never travels alone — pair it with a word or icon.
- Accent actions: `bg-accent text-accent-fg`, hover `bg-accent-hover`.
- Type scale: `text-2xs` … `text-2xl` off a 13px base. Never hard-code font sizes in px —
  the scale is user-adjustable at runtime. `tabular` on any numerals meant to be compared.
- Focus: `focus-visible:outline-2` (+ an offset variant when flush against an edge). Don't
  add ring utilities.
- Never reduce text with opacity utilities (`opacity-40`); use `text-muted`, or `invisible`
  to hide.
- Any user- or ATS-sourced string can be absurdly long: give its container `min-w-0` and the
  text `break-words`; in headers prefer `flex-wrap` over `truncate`.

## Idioms

- A navigation styled as a button is an anchor: `<a className={buttonClass("secondary", "sm")}>`
  — `buttonClass` is exported on this bundle. Real `<Button>` is for actions.
- Empty states are three different things (finished / nothing matches / nothing yet) — pick
  the one that's true and say what to do next; `EmptyState` takes an action for that.
- Layout glue is plain Tailwind (`flex`, `gap-*`, `p-*` on the spacing scale); components
  carry their own internal styling.

## Where the truth lives

Read `styles.css` (it imports `_ds_bundle.css` — every token and utility above is defined
there) before styling anything. Each component's API is its `<Name>.d.ts`; usage and
composition examples are in its `<Name>.prompt.md`.

## One idiomatic composition

```jsx
<div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-3 min-w-0">
  <div className="flex items-center gap-2 flex-wrap">
    <h3 className="text-lg font-semibold text-text break-words">Ramp</h3>
    <Badge tone="ok">day-of · verified</Badge>
  </div>
  <p className="text-sm text-text-2">Product Manager, Core Platform — posted this week.</p>
  <div className="flex gap-2">
    <Button variant="primary" size="sm">Add to pipeline</Button>
    <a className={buttonClass("secondary", "sm")} href="#">Open posting</a>
  </div>
</div>
```
