"use client";

import { MessageSquare } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import type { ApplicationView, NoteView } from "@/lib/data/view-models";
import { noteAuthorLabel } from "@/lib/data/view-models";
import { fmtStamp } from "@/lib/format";
import { loadNotesAction } from "./actions";

/**
 * The note history, in a Radix `Dialog`.
 *
 * Newest first, with a compose box UNDER the list and no editable textarea over
 * the old value. That is deliberate: notes are append-only in the database
 * (`revoke update, delete`, migration 0010), and a UI that looks editable
 * teaches people to expect an edit that will never work. Appending a correction
 * is the gesture; the history is the point.
 *
 * History is fetched when the dialog opens rather than shipped with every row.
 * The pipeline is a list of tens of rows and the panel is opened on one of them,
 * so paying for every row's full history on every page load to serve a panel
 * nobody has opened is the wrong trade.
 */
export function NotesDialog({
  app,
  busy,
  onAdd,
}: {
  app: ApplicationView;
  busy?: boolean;
  /** Resolves to true when the note landed, so the dialog can clear its box. */
  onAdd: (body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  const [notes, setNotes] = React.useState<NoteView[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const res = await loadNotesAction(app.id);
      if (!res.ok) {
        // Named, not silent. An empty list and a failed read look identical on
        // screen and mean opposite things — the same lesson as matrix row 15.
        setLoadError(
          res.kind === "auth"
            ? "Your session expired. Sign in to see the history."
            : res.message,
        );
        setNotes([]);
        return;
      }
      setNotes(res.notes);
    } catch {
      setLoadError("Couldn't load the history.");
      setNotes([]);
    }
  }, [app.id]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <DialogTrigger
        data-testid={`notes-trigger-${app.id}`}
        aria-label={`Notes for ${app.company}, ${app.title}`}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted
                   hover:bg-raised hover:text-text focus-visible:outline-2
                   focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <MessageSquare aria-hidden="true" className="size-3.5" />
        <span className="tabular">{app.noteCount}</span>
      </DialogTrigger>

      <DialogContent
        title="Notes"
        description={`${app.company}, ${app.title}`}
      >
        <div data-testid={`notes-list-${app.id}`} className="space-y-3">
          {notes === null ? (
            <p className="text-xs text-muted">Loading</p>
          ) : loadError ? (
            <p className="text-xs text-danger">{loadError}</p>
          ) : notes.length === 0 ? (
            <p className="text-xs text-muted">
              No notes yet. Anything you add here stays. Notes are never overwritten.
            </p>
          ) : (
            <ol className="space-y-3">
              {notes.map((n) => (
                <li key={n.id} className="border-l-2 border-border pl-3">
                  {/* Its own testid: a test asserting the exact ORDER of bodies
                      otherwise has to exclude the byline paragraph by matching
                      its text, which breaks the moment an author label changes. */}
                  <p
                    data-testid="note-body"
                    className="whitespace-pre-wrap break-words text-xs text-text"
                  >
                    {n.body}
                  </p>
                  <p className="mt-1 text-2xs text-muted">
                    {noteAuthorLabel(n.author)}, {fmtStamp(n.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>

        <form
          className="mt-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const body = draft.trim();
            if (!body || saving) return;
            setSaving(true);
            const landed = await onAdd(body);
            setSaving(false);
            if (landed) {
              setDraft("");
              await load();
            }
          }}
        >
          <label htmlFor={`note-body-${app.id}`} className="text-2xs font-medium text-muted">
            Add a note
          </label>
          <textarea
            id={`note-body-${app.id}`}
            data-testid={`note-input-${app.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={4000}
            className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5
                       text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-1
                       focus-visible:outline-ring"
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              // Disabled on a blank box rather than submitting and showing a red
              // toast: the server refuses it, and a refusal for pressing a button
              // that looked ready is a worse answer than a button that says it is not.
              disabled={!draft.trim() || saving || busy}
              data-testid={`note-save-${app.id}`}
            >
              {saving ? "Saving" : "Add note"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
