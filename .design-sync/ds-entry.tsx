/**
 * Extra bundle entry for the app-level composites.
 *
 * The six primitives under `webapp/components/ui/` are picked up automatically:
 * `cfg.srcDir` points there, and with no library build the converter
 * synthesizes its entry by star-exporting every file in that directory.
 *
 * The composites live under `webapp/app/(app)/…`, one per route folder, and are
 * mostly `export default`. A star-export entry drops defaults, and there is no
 * directory that contains the composites and nothing else — every route folder
 * also holds `actions.ts` (`"use server"` → `next/headers`) or a `page.tsx` that
 * reads the data source. So the composites are named here explicitly and wired
 * in through `cfg.extraEntries`.
 *
 * INCLUSION RULE — a component belongs here only if its import closure is
 * browser-safe: no `server-only`, no `next/headers`, no `"use server"` module,
 * no `next/navigation` (no router context in a preview card). Everything else
 * ships the honest floor card instead. See `.design-sync/NOTES.md`.
 *
 * Not every export below is a synced component. `StepShell`,
 * `ProvenancePopoverContent` and the `Dialog` re-exports are on the global so an
 * authored preview can compose a leaf inside the parent it actually needs.
 */

/**
 * `toast` is re-exported from the DS's OWN sonner instance on purpose. `Toaster`
 * is bundled into `_ds_bundle.js` with its copy of sonner; a preview (or a
 * design) importing `sonner` separately gets a SECOND module instance whose
 * `toast()` never reaches the mounted host, and the toast silently never appears.
 * Shipping it here means `window.JobHQ.toast` and `window.JobHQ.Toaster` are
 * always the same instance.
 */
export { toast } from "sonner";

/**
 * Same instance rule, same reason. `ProvenancePopoverContent` renders a
 * `Popover.Portal` that reads its context from the radix copy bundled into
 * `_ds_bundle.js`; a preview importing `radix-ui` on its own gets a different
 * copy and the portal throws "must be used within Popover.Root". The Dialog
 * pieces need no equivalent — `components/ui/dialog.tsx` already re-exports
 * `Dialog` / `DialogTrigger` / `DialogClose` from the DS's own radix.
 */
export { Popover } from "radix-ui";

export { TriageCard } from "@/app/(app)/queue/triage-card";
export { default as CoverageMeter } from "@/app/(app)/companies/coverage-meter";
export { ProvenanceChip, ProvenancePopoverContent } from "@/app/(app)/companies/provenance-popover";
export { default as ReviewBar } from "@/app/(app)/companies/review-bar";
export { default as SelectionBar } from "@/app/(app)/jobs/selection-bar";
export { StatusSelect } from "@/app/(app)/pipeline/status-select";
export { StepHeader, StepShell } from "@/app/(app)/import/step-shell";
export { PreviewPanel } from "@/app/(app)/settings/preview-panel";
