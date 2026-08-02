"use client";

/**
 * Saving a view, from the one affordance the new chrome has for it.
 *
 * 03 §2: "a saved view is a named query, not a place". The redesigned toolbar
 * shows saved views as tabs and grows a "Save view" tab only while the current
 * query is dirty — so every write to `saved_views` has to happen here, in one
 * dialog, instead of in the eleven menu items the shipped switcher carried.
 *
 * Three gestures, because there are three real situations and no more:
 *   - the base is a built-in tab: save the current query as a NEW named view;
 *   - the base is one of your views and the query drifted: update it, or fork
 *     it under a new name;
 *   - the base is one of your views and you want it gone: delete it.
 * "Use as my landing view" rides on the create form as a checkbox, because
 * `is_default` has nowhere else to live once the switcher menu is gone.
 *
 * Every write is a server action with a fresh idempotency key and the
 * `updatedAt` this client last read — the shipped contract, unchanged (07 §1).
 */

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ds";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import type { SavedView } from "@/lib/data/view-models";
import type { DisplayState } from "@/lib/grid/view-state";
import { makeViewState } from "@/lib/grid/view-state";
import type { GridUrlState } from "@/lib/grid/url-state";
import { deleteViewAction, saveViewAction } from "./view-actions";

export type SaveViewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The view the current query is based on, when it is one of the user's. */
  base: SavedView | null;
  /** The query and display state on screen — what a save captures. */
  nav: GridUrlState;
  display: DisplayState;
  onSaved: (view: SavedView) => void;
  onDeleted: () => void;
  onConflict: () => void;
};

export default function SaveViewDialog(props: SaveViewDialogProps) {
  const { base, nav, display } = props;
  const [name, setName] = React.useState("");
  const [landing, setLanding] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // One key per GESTURE, reused by every retry of it. A fresh uuid per attempt
  // is what makes a retry apply twice against an append-only trail.
  const idem = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!props.open) return;
    setName("");
    setLanding(false);
    setError(null);
    idem.current = null;
  }, [props.open]);

  const state = makeViewState(nav, display);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A view needs a name.");
      return;
    }
    setPending(true);
    setError(null);
    idem.current ??= crypto.randomUUID();
    let res: Awaited<ReturnType<typeof saveViewAction>>;
    try {
      res = await saveViewAction({
        id: null,
        name: trimmed,
        surface: "jobs",
        state,
        isDefault: landing,
        idempotencyKey: idem.current,
        expectedUpdatedAt: null,
      });
    } catch {
      setPending(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    setPending(false);
    if (res.ok) {
      idem.current = null;
      toast(`Saved the view "${trimmed}"`);
      props.onOpenChange(false);
      props.onSaved(res.view);
      return;
    }
    if (res.kind === "auth") {
      setError("Your session expired. Sign in and try again.");
      return;
    }
    // A create cannot conflict — there is no prior version to disagree with —
    // but the result type carries the arm, and narrowing on it beats asserting
    // it away: the day `saveView` starts checking a name collision this branch
    // is already honest instead of reading `undefined`.
    setError(
      res.kind === "error"
        ? res.message
        : "A view with that name changed on another device. Reload and try again.",
    );
  }

  async function update() {
    if (!base) return;
    setPending(true);
    setError(null);
    idem.current ??= crypto.randomUUID();
    let res: Awaited<ReturnType<typeof saveViewAction>>;
    try {
      res = await saveViewAction({
        id: base.id,
        name: base.name,
        surface: "jobs",
        state,
        isDefault: base.isDefault,
        idempotencyKey: idem.current,
        expectedUpdatedAt: base.updatedAt,
      });
    } catch {
      setPending(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    setPending(false);
    if (res.ok) {
      idem.current = null;
      toast(`Updated "${base.name}"`);
      props.onOpenChange(false);
      props.onSaved(res.view);
      return;
    }
    if (res.kind === "conflict") {
      // The other device's saved state is the truth now, and keeping the losing
      // edit on screen would claim otherwise.
      props.onOpenChange(false);
      toast.warning("That view changed on another device. Showing the latest.");
      props.onConflict();
      return;
    }
    setError(
      res.kind === "auth"
        ? "Your session expired. Sign in and try again."
        : res.kind === "error"
          ? res.message
          : "That view changed on another device. Reload to see the latest.",
    );
  }

  async function remove() {
    if (!base) return;
    setPending(true);
    setError(null);
    let res: Awaited<ReturnType<typeof deleteViewAction>>;
    try {
      res = await deleteViewAction({ id: base.id, idempotencyKey: crypto.randomUUID() });
    } catch {
      setPending(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    setPending(false);
    if (res.ok) {
      toast(`Deleted "${base.name}"`);
      props.onOpenChange(false);
      props.onDeleted();
      return;
    }
    setError(res.kind === "auth" ? "Your session expired. Sign in and try again." : res.message);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title="Save this view">
        <div className="flex flex-col gap-3 text-sm" data-testid="save-view-dialog">
          {base ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={pending} onClick={() => void update()}>
                Update {base.name}
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => void remove()}>
                Delete this view
              </Button>
            </div>
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="font-medium">{base ? "Or save as a new view" : "Name"}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
              maxLength={80}
              placeholder="e.g. Remote, above $150k"
              data-testid="save-view-name"
              className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-text
                         placeholder:text-muted focus-visible:outline-2
                         focus-visible:-outline-offset-1 focus-visible:outline-ring"
            />
          </label>

          <label className="flex items-center gap-2 text-text-2">
            <input
              type="checkbox"
              checked={landing}
              onChange={(e) => setLanding(e.target.checked)}
            />
            Open this view when I go to Jobs
          </label>

          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Keep editing</Button>
            </DialogClose>
            <Button variant="primary" disabled={pending} onClick={() => void create()}>
              Save view
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
