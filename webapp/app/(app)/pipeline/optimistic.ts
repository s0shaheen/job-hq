import type { ApplicationView } from "@/lib/data/view-models";

/**
 * What a gesture shows BEFORE the server answers.
 *
 * Extracted from the table for one reason: it is the only place the optimistic
 * frame can be asserted. A test driving the browser cannot see it — the demo
 * store answers in under a millisecond, so Playwright's retrying `expect`
 * evaluates after the server row has already landed. A mutant that applied a
 * declined suggestion optimistically therefore passed the entire E2E suite,
 * which is the "test that cannot fail" shape this repo bins on sight.
 *
 * As a pure function it is deterministic, and `optimistic.test.ts` pins each
 * gesture's patch by its KEY SET as well as its values — because the bug being
 * guarded against is a key that should not be there at all.
 */
export type Gesture =
  | { kind: "status"; status: string }
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "note" }
  | { kind: "next-action"; text: string; date: string | null };

export function optimisticPatch(
  app: ApplicationView,
  gesture: Gesture,
): Partial<ApplicationView> {
  switch (gesture.kind) {
    case "status":
      return {
        status: gesture.status,
        // `statusActor` moves too, because it is what hides the suggestion
        // buttons — leaving Confirm/Not-this on screen for a frame after the
        // human has answered the question themselves reads as a bug.
        statusActor: "user",
        suggestedStatus: null,
      };
    case "confirm":
      return {
        status: app.suggestedStatus ?? app.status,
        statusActor: "user", // confirming IS a human decision
        suggestedStatus: null,
      };
    case "reject":
      // Matrix row 42, at the frame level. Clearing the suggestion is the WHOLE
      // patch: `status` and `statusActor` must not appear here at all. Declining
      // one suggestion is not a claim over the row, and painting the declined
      // status even briefly is the failure this row is named for.
      return { suggestedStatus: null };
    case "note":
      // Deliberately not `updatedAt`: a note does not change the application row,
      // and moving the token would invalidate every other tab's copy.
      return { noteCount: app.noteCount + 1 };
    case "next-action":
      return {
        nextAction: gesture.text || null,
        nextActionDate: gesture.date,
      };
  }
}
