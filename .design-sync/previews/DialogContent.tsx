import { Button, Dialog, DialogClose, DialogContent, DialogTrigger } from "hq-webapp";

/**
 * `DialogContent` mounts nothing on its own — it is the panel inside Radix's
 * `Dialog` root, so every card composes the whole thing. `defaultOpen` renders
 * the open state statically; no interaction needed.
 *
 * Shapes are the app's two real dialogs: the note history on /pipeline
 * (append-only, compose box under the list) and the export dialog's footer
 * pairing (a ghost Cancel beside the committing primary).
 *
 * The panel is `position: fixed` and portalled, which is why this component
 * carries a `cardMode: "single"` override.
 */

/** The common shape: title, description, body, and a two-button footer. */
export function Confirm() {
  return (
    <Dialog defaultOpen>
      <DialogContent
        title="Delete “Chicago fintech, day-of”?"
        description="This removes the saved view for everyone who has the link. The postings themselves are untouched."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger">Delete view</Button>
          </>
        }
      >
        <p className="text-sm text-text-2">
          You can rebuild it from the filter bar — the view is a saved set of filters,
          not a copy of the rows.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The pipeline's note history. Newest first, with the compose box UNDER the
 * list and no editable textarea over the old value: notes are append-only in
 * the database, and a UI that looks editable teaches people to expect an edit
 * that will never work.
 */
export function NoteHistory() {
  return (
    <Dialog defaultOpen>
      <DialogContent
        title="Notes — Ramp, Product Manager, Core Platform"
        description="Appended, never edited. A correction is a new note."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Close</Button>
            </DialogClose>
            <Button variant="primary">Add note</Button>
          </>
        }
      >
        <ul className="space-y-2.5">
          <li className="rounded-md border border-border bg-raised p-2.5">
            <p className="text-sm text-text">
              Recruiter screen booked for Thursday 10:00 — asked for the ledger migration
              story.
            </p>
            <p className="mt-1 text-2xs text-muted">You · 21 Jul 2026, 09:14</p>
          </li>
          <li className="rounded-md border border-border bg-raised p-2.5">
            <p className="text-sm text-text">
              Applied through the Ashby board, referral from the Modern Treasury thread.
            </p>
            <p className="mt-1 text-2xs text-muted">You · 18 Jul 2026, 16:02</p>
          </li>
          <li className="rounded-md border border-border bg-raised p-2.5">
            <p className="text-sm text-text">Confirmation email captured from Gmail.</p>
            <p className="mt-1 text-2xs text-muted">Capture · 18 Jul 2026, 16:05</p>
          </li>
        </ul>
        <textarea
          rows={2}
          placeholder="Add a note…"
          className="mt-3 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm
                     text-text placeholder:text-muted focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        />
      </DialogContent>
    </Dialog>
  );
}

/** Title only — no description, no footer. The floor of the API. */
export function TitleOnly() {
  return (
    <Dialog defaultOpen>
      <DialogContent title="Keyboard shortcuts">
        <p className="text-sm text-text-2">
          Everything on this page can be driven from the keyboard. Press Escape to close.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** Closed, showing the trigger a person actually clicks. */
export function ClosedWithTrigger() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">Notes (3)</Button>
      </DialogTrigger>
      <DialogContent title="Notes" footer={<Button variant="primary">Add note</Button>}>
        <p className="text-sm text-text-2">Nothing yet.</p>
      </DialogContent>
    </Dialog>
  );
}
