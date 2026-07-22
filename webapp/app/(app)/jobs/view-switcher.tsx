"use client";

import { Check, ChevronDown, Layers } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import type { SaveViewResult } from "@/lib/data/source";
import type { SavedView } from "@/lib/data/view-models";
import {
  GRID_PRESETS,
  PERSONA_PRESETS,
  presetName,
  type PersonaPreset,
  type WorkingSet,
} from "@/lib/grid/presets";
import type { GridUrlState } from "@/lib/grid/url-state";
import {
  makeViewState,
  type Density,
  type DisplayState,
  type GridBase,
  type TypeScale,
} from "@/lib/grid/view-state";
import { deleteViewAction, saveViewAction } from "./view-actions";

/**
 * The view switcher — a quiet dropdown, not a sidebar. One trigger carries the
 * active view's name and a subdued "· edited" when the on-screen state has
 * drifted from it; the menu holds the built-in presets (code, never
 * deletable), the user's saved views, the persona seeds, the display knobs,
 * and — only when they apply — Save / Save as… / Reset / landing / delete.
 *
 * Every write goes through the server actions with a fresh idempotency key and
 * the `updatedAt` this client last read — the same contract as triage, so a
 * double-click is free and a second device is a visible conflict. The toasts
 * reuse the queue's copy conventions rather than inventing new ones.
 */

export type ViewSwitcherProps = {
  views: SavedView[];
  base: GridBase;
  edited: boolean;
  /** The effective nav + display on screen — what Save/Save as… capture. */
  nav: GridUrlState;
  display: DisplayState;
  onSelectPreset: (set: WorkingSet) => void;
  onSelectView: (id: string) => void;
  onApplyPersona: (p: PersonaPreset) => void;
  onDisplayChange: (d: DisplayState) => void;
  /** A save landed (create or update): adopt the server's row. */
  onSaved: (view: SavedView) => void;
  /** A save conflicted: return to the stored state, which is the truth now. */
  onConflict: () => void;
  onDeleted: () => void;
  onReset: () => void;
};

const itemClass =
  "relative flex h-7 min-w-0 cursor-default select-none items-center gap-2 rounded-md pl-6 pr-2 " +
  "text-xs text-text outline-none data-[highlighted]:bg-raised";

const labelClass = "px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted";

function Indicator() {
  return (
    <DropdownMenu.ItemIndicator className="absolute left-1.5">
      <Check aria-hidden="true" className="size-3.5" />
    </DropdownMenu.ItemIndicator>
  );
}

export default function ViewSwitcher(props: ViewSwitcherProps) {
  const { views, base, edited, nav, display } = props;

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [saveAsOpen, setSaveAsOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [landing, setLanding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const baseName = base.kind === "view" ? base.view.name : presetName(base.set);
  const activeKey = base.kind === "view" ? `v:${base.view.id}` : `p:${base.set}`;
  // Alphabetical, so the fixture store (insertion order) and Supabase
  // (ORDER BY name) present the same list.
  const sortedViews = [...views].sort((a, b) => a.name.localeCompare(b.name));

  /** Menu item → dialog: close the menu FIRST (it is controlled), or its
   *  focus-restore to the trigger fights the dialog's focus trap. */
  const openDialog = (open: (v: boolean) => void) => (e: Event) => {
    e.preventDefault();
    setMenuOpen(false);
    open(true);
  };

  const saveInPlace = async (over?: { state?: unknown; isDefault?: boolean; toastText?: string }) => {
    if (base.kind !== "view") return;
    const v = base.view;
    let res: SaveViewResult;
    try {
      res = await saveViewAction({
        id: v.id,
        name: v.name,
        surface: "jobs",
        state: over?.state ?? makeViewState(nav, display),
        isDefault: over?.isDefault ?? v.isDefault,
        idempotencyKey: crypto.randomUUID(),
        expectedUpdatedAt: v.updatedAt,
      });
    } catch {
      toast.error("Couldn't save the view.", {
        description: "Check your connection and try again.",
      });
      return;
    }
    if (res.ok) {
      toast(over?.toastText ?? `Saved “${v.name}”`);
      props.onSaved(res.view);
      return;
    }
    if (res.kind === "conflict") {
      toast.warning("This view was changed on another device — showing the latest.");
      props.onConflict();
      return;
    }
    if (res.kind === "auth") {
      toast.error("Couldn't save the view — your session expired.", {
        description: "Sign in and try again.",
      });
      return;
    }
    toast.error("Couldn't save the view.", { description: res.message });
  };

  const submitSaveAs = async () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    let res: SaveViewResult;
    try {
      res = await saveViewAction({
        id: null,
        name: trimmed,
        surface: "jobs",
        state: makeViewState(nav, display),
        isDefault: landing,
        idempotencyKey: crypto.randomUUID(),
        expectedUpdatedAt: null,
      });
    } catch {
      setPending(false);
      setError("Couldn't reach the server — check your connection and try again.");
      return;
    }
    setPending(false);
    if (res.ok) {
      setSaveAsOpen(false);
      setName("");
      setLanding(false);
      toast(`Saved “${trimmed}”`);
      props.onSaved(res.view);
      return;
    }
    // The dialog stays open with the store's own message — a rejected name is
    // a correction to make, not a crash and not a silent overwrite.
    if (res.kind === "auth") setError("Your session expired — sign in and try again.");
    else if (res.kind === "conflict") setError("This view was changed on another device.");
    else setError(res.message);
  };

  const doDelete = async () => {
    if (base.kind !== "view" || pending) return;
    const v = base.view;
    setPending(true);
    let res: Awaited<ReturnType<typeof deleteViewAction>>;
    try {
      res = await deleteViewAction({ id: v.id, idempotencyKey: crypto.randomUUID() });
    } catch {
      setPending(false);
      toast.error("Couldn't delete the view.", {
        description: "Check your connection and try again.",
      });
      return;
    }
    setPending(false);
    setConfirmOpen(false);
    if (res.ok) {
      toast(`Deleted “${v.name}”`);
      props.onDeleted();
      return;
    }
    if (res.kind === "auth") {
      toast.error("Couldn't delete the view — your session expired.", {
        description: "Sign in and try again.",
      });
      return;
    }
    toast.error("Couldn't delete the view.", { description: res.message });
  };

  const control =
    "h-7 rounded-md border border-border-strong bg-surface px-2 text-xs text-text " +
    "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring";

  return (
    <>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="view-switcher"
            data-edited={edited ? "true" : undefined}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface
                       px-2 text-xs font-medium text-text-2 hover:bg-raised
                       focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
          >
            <Layers aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="max-w-36 truncate">{baseName}</span>
            {edited ? <span className="font-normal text-muted">· edited</span> : null}
            <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-40 max-h-[min(70vh,32rem)] w-60 overflow-y-auto rounded-lg border border-border
                       bg-surface p-1 shadow-xl outline-none"
          >
            <DropdownMenu.Label className={labelClass}>Views</DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={activeKey}
              onValueChange={(key) => {
                if (key.startsWith("p:")) props.onSelectPreset(key.slice(2) as WorkingSet);
                else props.onSelectView(key.slice(2));
              }}
            >
              {GRID_PRESETS.map((p) => (
                <DropdownMenu.RadioItem key={p.set} value={`p:${p.set}`} className={itemClass}>
                  <Indicator />
                  {p.name}
                </DropdownMenu.RadioItem>
              ))}
              {sortedViews.map((v) => (
                <DropdownMenu.RadioItem key={v.id} value={`v:${v.id}`} className={itemClass}>
                  <Indicator />
                  <span className="min-w-0 truncate">{v.name}</span>
                  {v.isDefault ? (
                    <span className="ml-auto shrink-0 text-2xs text-muted">landing</span>
                  ) : null}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Label className={labelClass}>Start from a persona</DropdownMenu.Label>
            {PERSONA_PRESETS.map((p) => (
              <DropdownMenu.Item
                key={p.id}
                className={itemClass}
                onSelect={() => props.onApplyPersona(p)}
              >
                {p.name}
              </DropdownMenu.Item>
            ))}

            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Label className={labelClass}>Display</DropdownMenu.Label>
            {/* Display knobs keep the menu open (preventDefault): flipping
                density and type together is one errand, not two menu trips. */}
            <DropdownMenu.RadioGroup
              value={display.density}
              onValueChange={(v) => props.onDisplayChange({ ...display, density: v as Density })}
            >
              <DropdownMenu.RadioItem
                value="dense"
                className={itemClass}
                onSelect={(e) => e.preventDefault()}
              >
                <Indicator />
                Dense
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem
                value="comfortable"
                className={itemClass}
                onSelect={(e) => e.preventDefault()}
              >
                <Indicator />
                Comfortable
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
            <DropdownMenu.RadioGroup
              value={display.typeScale}
              onValueChange={(v) => props.onDisplayChange({ ...display, typeScale: v as TypeScale })}
            >
              <DropdownMenu.RadioItem
                value="default"
                className={itemClass}
                onSelect={(e) => e.preventDefault()}
              >
                <Indicator />
                Default type
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem
                value="large"
                className={itemClass}
                onSelect={(e) => e.preventDefault()}
              >
                <Indicator />
                Large type
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
            <DropdownMenu.CheckboxItem
              checked={display.hints}
              onCheckedChange={(c) => props.onDisplayChange({ ...display, hints: c === true })}
              onSelect={(e) => e.preventDefault()}
              className={itemClass}
            >
              <Indicator />
              Keyboard hints
            </DropdownMenu.CheckboxItem>

            {edited || base.kind === "view" ? (
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            ) : null}
            {edited && base.kind === "view" ? (
              <DropdownMenu.Item className={itemClass} onSelect={() => void saveInPlace()}>
                Save
              </DropdownMenu.Item>
            ) : null}
            {edited ? (
              <DropdownMenu.Item className={itemClass} onSelect={openDialog(setSaveAsOpen)}>
                Save as…
              </DropdownMenu.Item>
            ) : null}
            {edited ? (
              <DropdownMenu.Item className={itemClass} onSelect={() => props.onReset()}>
                Reset
              </DropdownMenu.Item>
            ) : null}
            {base.kind === "view" && !base.view.isDefault ? (
              <DropdownMenu.Item
                className={itemClass}
                onSelect={() =>
                  void saveInPlace({
                    // The SAVED state, not the on-screen edit: making a view
                    // the landing page must not smuggle unsaved changes in.
                    state: base.view.state,
                    isDefault: true,
                    toastText: `“${base.view.name}” is now your landing view`,
                  })
                }
              >
                Use as my landing view
              </DropdownMenu.Item>
            ) : null}
            {base.kind === "view" ? (
              <DropdownMenu.Item
                className={`${itemClass} text-danger`}
                onSelect={openDialog(setConfirmOpen)}
              >
                Delete view…
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog
        open={saveAsOpen}
        onOpenChange={(o) => {
          setSaveAsOpen(o);
          if (!o) {
            setName("");
            setLanding(false);
            setError(null);
          }
        }}
      >
        <DialogContent
          title="Save view"
          description="Filters, sort, grouping and display settings are saved together."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitSaveAs();
            }}
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-text-2">
              View name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                maxLength={80}
                placeholder="e.g. Remote, senior-friendly"
                className={control}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-text-2">
              <input
                type="checkbox"
                checked={landing}
                onChange={(e) => setLanding(e.target.checked)}
              />
              Use as my landing view
            </label>
            {error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
            <div className="mt-1 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" size="sm" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm" variant="primary" disabled={pending || !name.trim()}>
                Save view
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent
          title="Delete view"
          description={
            base.kind === "view"
              ? `“${base.view.name}” will be gone from every device. This cannot be undone.`
              : undefined
          }
          footer={
            <>
              <DialogClose asChild>
                <Button type="button" size="sm" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => void doDelete()}
              >
                Delete
              </Button>
            </>
          }
        />
      </Dialog>
    </>
  );
}
