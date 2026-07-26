import { describe, expect, it } from "vitest";
import { optimisticPatch } from "@/app/(app)/pipeline/optimistic";
import { FIXTURE_APPLICATIONS } from "@/lib/data/fixtures";
import type { ApplicationView } from "@/lib/data/view-models";

/**
 * The optimistic frame — what the row shows before the server answers.
 *
 * This file exists because an E2E cannot cover it. The demo store answers in
 * under a millisecond, so Playwright's retrying `expect` always evaluates AFTER
 * the server row has replaced the optimistic one: a mutant that optimistically
 * applied a declined suggestion passed all 46 pipeline E2E tests and both
 * projects. Watching that happen is what produced this file.
 *
 * Every assertion is on the KEY SET as well as the values, because the bug class
 * is a key that should not be present at all.
 */

const suggestionRow = FIXTURE_APPLICATIONS.find((a) => a.suggestedStatus)!;
const plainRow = FIXTURE_APPLICATIONS.find((a) => !a.suggestedStatus)!;

const keys = (p: Partial<ApplicationView>) => Object.keys(p).sort();

describe("reject", () => {
  it("clears the suggestion and touches NOTHING else", () => {
    // Matrix row 42. The entire patch is one key.
    const patch = optimisticPatch(suggestionRow, { kind: "reject" });
    expect(keys(patch)).toEqual(["suggestedStatus"]);
    expect(patch.suggestedStatus).toBeNull();
  });

  it("never carries a status, even as the value it already had", () => {
    // Spelled out separately: `status: app.status` would be a no-op in practice
    // and still wrong, because the next refactor makes it the suggested one.
    const patch = optimisticPatch(suggestionRow, { kind: "reject" });
    expect("status" in patch).toBe(false);
    expect("statusActor" in patch).toBe(false);
  });
});

describe("confirm", () => {
  it("applies the suggestion and claims the row", () => {
    const patch = optimisticPatch(suggestionRow, { kind: "confirm" });
    expect(keys(patch)).toEqual(["status", "statusActor", "suggestedStatus"]);
    expect(patch.status).toBe(suggestionRow.suggestedStatus);
    expect(patch.statusActor).toBe("user");
    expect(patch.suggestedStatus).toBeNull();
  });

  it("falls back to the current status when there is nothing to confirm", () => {
    // The button is not rendered in this state, but a replayed gesture can still
    // arrive here — and `status: undefined` would blank the pill.
    const patch = optimisticPatch(plainRow, { kind: "confirm" });
    expect(patch.status).toBe(plainRow.status);
  });
});

describe("status", () => {
  it("sets the status, claims the row, and clears any suggestion", () => {
    const patch = optimisticPatch(suggestionRow, { kind: "status", status: "Offer" });
    expect(keys(patch)).toEqual(["status", "statusActor", "suggestedStatus"]);
    expect(patch.status).toBe("Offer");
    expect(patch.statusActor).toBe("user");
    // A human choosing a status answers the bot's question by making it moot.
    expect(patch.suggestedStatus).toBeNull();
  });

  it("passes an invented status through unchanged", () => {
    const patch = optimisticPatch(plainRow, { kind: "status", status: "waiting on panel" });
    expect(patch.status).toBe("waiting on panel");
  });
});

describe("note", () => {
  it("bumps only the count", () => {
    const patch = optimisticPatch(plainRow, { kind: "note" });
    expect(keys(patch)).toEqual(["noteCount"]);
    expect(patch.noteCount).toBe(plainRow.noteCount + 1);
  });

  it("does not move the version token", () => {
    // The application row did not change. Moving `updatedAt` here would
    // invalidate every other tab's token and produce a phantom conflict on the
    // next real gesture — for typing a comment.
    expect("updatedAt" in optimisticPatch(plainRow, { kind: "note" })).toBe(false);
  });
});

describe("next-action", () => {
  it("stores text and date", () => {
    const patch = optimisticPatch(plainRow, {
      kind: "next-action",
      text: "Chase the recruiter",
      date: "2026-08-03",
    });
    expect(keys(patch)).toEqual(["nextAction", "nextActionDate"]);
    expect(patch.nextAction).toBe("Chase the recruiter");
    expect(patch.nextActionDate).toBe("2026-08-03");
  });

  it("clears to null rather than an empty string", () => {
    // "" and null are different claims, and the export writes different bytes.
    const patch = optimisticPatch(plainRow, { kind: "next-action", text: "", date: null });
    expect(patch.nextAction).toBeNull();
    expect(patch.nextActionDate).toBeNull();
  });

  it("never touches the status", () => {
    const patch = optimisticPatch(plainRow, { kind: "next-action", text: "x", date: null });
    expect("status" in patch).toBe(false);
    expect("statusActor" in patch).toBe(false);
  });
});

describe("the fixture rows these assertions need", () => {
  it("has a row with a suggestion and one without", () => {
    // Otherwise half the file above asserts against undefined and passes.
    expect(suggestionRow.suggestedStatus).toBeTruthy();
    expect(plainRow.suggestedStatus).toBeNull();
  });
});
