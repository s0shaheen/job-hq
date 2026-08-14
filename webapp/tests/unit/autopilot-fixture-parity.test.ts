import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_APPLICATIONS } from "@/lib/data/fixtures";
import type { StageAutopilotInput } from "@/lib/data/source";

/**
 * Fixture parity for the autopilot commands (#206): every REAL behaviour the
 * RPCs have — including the failures — is reachable through the fake, because
 * a fake that only models the happy path hides exactly the bug it exists to
 * catch (this file's header rule). The sentences asserted here are the
 * migration's own, so the fake and the database cannot drift silently.
 */

function stageInput(
  applicationId: number,
  over: Partial<StageAutopilotInput> = {},
): StageAutopilotInput {
  return {
    applicationId,
    provider: "greenhouse",
    providerVersion: "v1",
    formIdentity: "board-1",
    formSchemaHash: "sch-1",
    payload: { first_name: "A" },
    attachments: [],
    answers: {},
    gaps: [],
    state: "ready_for_review",
    reason: "",
    idempotencyKey: crypto.randomUUID(),
    expectedUpdatedAt: null,
    ...over,
  };
}

/** A source whose app #1 is keyed and app #101 is its MANUAL sibling. */
function sourceWithSibling(): { src: FixtureDataSource; keyed: number; manual: number } {
  const keyed = FIXTURE_APPLICATIONS[0];
  const apps = [
    ...FIXTURE_APPLICATIONS.map((a) => ({ ...a })),
    { ...keyed, id: 101, postingKey: null, url: null },
  ];
  return { src: new FixtureDataSource(undefined, apps), keyed: keyed.id, manual: 101 };
}

async function approvedStage(src: FixtureDataSource, applicationId: number) {
  const staged = await src.stageAutopilot(stageInput(applicationId));
  if (!staged.ok) throw new Error("staging failed");
  const approved = await src.reviewAutopilotStage({
    stageId: staged.stage.id,
    decision: "approve",
    packageHash: staged.stage.packageHash,
    reason: "",
    idempotencyKey: crypto.randomUUID(),
    expectedUpdatedAt: null,
  });
  if (!approved.ok) throw new Error("approval failed");
  return approved.stage;
}

describe("staging", () => {
  it("creates, reads back, and the hash has the shape an approval must echo", async () => {
    const src = new FixtureDataSource();
    const out = await src.stageAutopilot(stageInput(1));
    expect(out.ok && out.created).toBe(true);
    if (!out.ok) return;
    expect(out.stage.state).toBe("ready_for_review");
    expect(out.stage.packageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.stage.approvedHash).toBeNull();
    const read = await src.autopilotStage(1);
    expect(read?.id).toBe(out.stage.id);
    expect(read?.packageHash).toBe(out.stage.packageHash);
  });

  it("replays the first answer under the same key, and refuses the key with different arguments", async () => {
    const src = new FixtureDataSource();
    const input = stageInput(1);
    const first = await src.stageAutopilot(input);
    const replay = await src.stageAutopilot(input);
    expect(replay).toEqual(first);

    const reused = await src.stageAutopilot({
      ...input,
      payload: { first_name: "B" },
    });
    expect(reused.ok).toBe(false);
    if (!reused.ok && reused.kind === "error") {
      expect(reused.message).toContain("different arguments");
    } else {
      expect.fail("a reused key with different arguments must be an error");
    }
  });

  it("refuses one key shared across commands, naming the first command", async () => {
    const src = new FixtureDataSource();
    const input = stageInput(1);
    const staged = await src.stageAutopilot(input);
    if (!staged.ok) return expect.fail("staging failed");
    const crossed = await src.reviewAutopilotStage({
      stageId: staged.stage.id,
      decision: "cancel",
      packageHash: null,
      reason: "",
      idempotencyKey: input.idempotencyKey,
      expectedUpdatedAt: null,
    });
    expect(crossed.ok).toBe(false);
    if (!crossed.ok && crossed.kind === "error") {
      expect(crossed.message).toContain("already used by app_stage_autopilot_application");
    }
  });

  it("a stale version token is a conflict carrying the server's row", async () => {
    const src = new FixtureDataSource();
    const staged = await src.stageAutopilot(stageInput(1));
    if (!staged.ok) return expect.fail("staging failed");
    const edited = await src.stageAutopilot(
      stageInput(1, { payload: { first_name: "B" } }),
    );
    if (!edited.ok) return expect.fail("edit failed");

    const stale = await src.stageAutopilot(
      stageInput(1, {
        payload: { first_name: "C" },
        expectedUpdatedAt: staged.stage.updatedAt,
      }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.kind === "conflict") {
      expect(stale.current?.payload).toEqual({ first_name: "B" });
    } else {
      expect.fail("a stale token must be a conflict");
    }
  });

  it("an approved package is frozen: re-staging it is a conflict, not an edit", async () => {
    const src = new FixtureDataSource();
    const stage = await approvedStage(src, 1);
    const restage = await src.stageAutopilot(
      stageInput(1, { payload: { first_name: "Z" } }),
    );
    expect(restage.ok).toBe(false);
    if (!restage.ok && restage.kind === "conflict") {
      expect(restage.current?.state).toBe("approved");
      expect(restage.current?.payload).toEqual(stage.payload);
    }
  });

  it("a sensitive answer not sourced from a user fact is refused with the guard's sentence", async () => {
    const src = new FixtureDataSource();
    const out = await src.stageAutopilot(
      stageInput(1, {
        answers: {
          visa_status: { value: "Yes", source: "constant", sensitive: true },
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok && out.kind === "error") {
      expect(out.message).toContain("may not store");
      expect(out.message).toContain("visa_status");
    }
  });

  it("an unknown answer source is refused by name", async () => {
    const src = new FixtureDataSource();
    const out = await src.stageAutopilot(
      stageInput(1, {
        answers: {
          nickname: { value: "Sam", source: "guessed" as never },
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok && out.kind === "error") {
      expect(out.message).toContain("unknown source");
    }
  });
});

describe("review", () => {
  it("approving echoes the displayed hash; a package changed since render is a conflict", async () => {
    const src = new FixtureDataSource();
    const staged = await src.stageAutopilot(stageInput(1));
    if (!staged.ok) return expect.fail("staging failed");
    const shown = staged.stage.packageHash;

    // A background re-stage lands between render and click.
    const moved = await src.stageAutopilot(
      stageInput(1, { payload: { first_name: "Changed" } }),
    );
    if (!moved.ok) return expect.fail("edit failed");
    expect(moved.stage.packageHash).not.toBe(shown);

    const approve = await src.reviewAutopilotStage({
      stageId: staged.stage.id,
      decision: "approve",
      packageHash: shown,
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(approve.ok).toBe(false);
    if (!approve.ok && approve.kind === "conflict") {
      expect(approve.current?.packageHash).toBe(moved.stage.packageHash);
    } else {
      expect.fail("an approval against a changed package must be a conflict");
    }

    const honest = await src.reviewAutopilotStage({
      stageId: staged.stage.id,
      decision: "approve",
      packageHash: moved.stage.packageHash,
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(honest.ok).toBe(true);
    if (honest.ok) {
      expect(honest.stage.state).toBe("approved");
      expect(honest.stage.approvedHash).toBe(moved.stage.packageHash);
    }
  });

  it("sending an approved package back clears the approval; cancel preserves it", async () => {
    const src = new FixtureDataSource();
    const approved = await approvedStage(src, 1);
    const back = await src.reviewAutopilotStage({
      stageId: approved.id,
      decision: "request_changes",
      packageHash: null,
      reason: "wrong resume",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.stage.state).toBe("changes_requested");
      expect(back.stage.approvedHash).toBeNull();
    }

    const approved2 = await approvedStage(src, 2);
    const cancel = await src.reviewAutopilotStage({
      stageId: approved2.id,
      decision: "cancel",
      packageHash: null,
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(cancel.ok).toBe(true);
    if (cancel.ok) {
      expect(cancel.stage.state).toBe("cancelled");
      expect(cancel.stage.approvedHash).toBe(approved2.approvedHash);
    }
  });
});

describe("the manual-handoff settle", () => {
  it("'submitted' settles handed_off and writes the MANUAL status through the status machinery", async () => {
    const src = new FixtureDataSource();
    // App 2 carries a bot suggestion — the manual write must clear it, which is
    // how this test proves the settle used the status lane, not a field write.
    const approved = await approvedStage(src, 2);
    const out = await src.settleAutopilotHandoff({
      stageId: approved.id,
      outcome: "submitted",
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.outcome).toBe("submitted");
    expect(out.stage.state).toBe("handed_off");
    expect(out.stage.approvedHash).toBe(approved.approvedHash);

    const apps = await src.applications();
    const app = apps.find((a) => a.id === 2);
    expect(app?.status).toBe("Applied");
    expect(app?.statusActor).toBe("user");
    expect(app?.suggestedStatus).toBeNull();
  });

  it("handed_off occupies the slot: staging that application again is a conflict", async () => {
    const src = new FixtureDataSource();
    const approved = await approvedStage(src, 1);
    await src.settleAutopilotHandoff({
      stageId: approved.id,
      outcome: "submitted",
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    const again = await src.stageAutopilot(stageInput(1));
    expect(again.ok).toBe(false);
    if (!again.ok && again.kind === "conflict") {
      expect(again.current?.state).toBe("handed_off");
    }
  });

  it("'abandoned' cancels, keeps the approval, releases the slot, and touches no status", async () => {
    const src = new FixtureDataSource();
    const approved = await approvedStage(src, 1);
    const out = await src.settleAutopilotHandoff({
      stageId: approved.id,
      outcome: "abandoned",
      reason: "the form was gone",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.outcome).toBe("abandoned");
    expect(out.stage.state).toBe("cancelled");
    expect(out.stage.approvedHash).toBe(approved.approvedHash);

    const apps = await src.applications();
    expect(apps.find((a) => a.id === 1)?.status).toBe("Interview");

    const again = await src.stageAutopilot(stageInput(1));
    expect(again.ok && again.created).toBe(true);
  });

  it("only an approved stage settles, and the refusal names the state", async () => {
    const src = new FixtureDataSource();
    const staged = await src.stageAutopilot(stageInput(1));
    if (!staged.ok) return expect.fail("staging failed");
    const out = await src.settleAutopilotHandoff({
      stageId: staged.stage.id,
      outcome: "submitted",
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(out.ok).toBe(false);
    if (!out.ok && out.kind === "error") {
      expect(out.message).toContain("has no manual handoff to settle");
      expect(out.message).toContain("ready_for_review");
    }
  });

  it("an unknown outcome is refused by name", async () => {
    const src = new FixtureDataSource();
    const approved = await approvedStage(src, 1);
    const out = await src.settleAutopilotHandoff({
      stageId: approved.id,
      outcome: "maybe" as never,
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(out.ok).toBe(false);
    if (!out.ok && out.kind === "error") {
      expect(out.message).toContain("unknown handoff outcome");
    }
  });

  it("reopening a finished application still demands a note — and the refused settle reverts whole", async () => {
    const src = new FixtureDataSource();
    const approved = await approvedStage(src, 1);
    const closed = await src.setStatus({
      applicationId: 1,
      status: "Rejected",
      note: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(closed.ok).toBe(true);

    const refused = await src.settleAutopilotHandoff({
      stageId: approved.id,
      outcome: "submitted",
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.kind === "error") {
      expect(refused.message).toBe("reopening needs a note saying why");
    }
    // The fake's stand-in for the transaction: the stage did NOT settle.
    const still = await src.autopilotStage(1);
    expect(still?.state).toBe("approved");
    expect(still?.updatedAt).toBe(approved.updatedAt);

    const withNote = await src.settleAutopilotHandoff({
      stageId: approved.id,
      outcome: "submitted",
      reason: "applied on the form after all",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    expect(withNote.ok).toBe(true);
    const apps = await src.applications();
    expect(apps.find((a) => a.id === 1)?.status).toBe("Applied");
  });
});

describe("the per-posting sibling guard", () => {
  it("a keyed row and its manual sibling cannot both hold a live attempt", async () => {
    const { src, keyed, manual } = sourceWithSibling();
    const first = await src.stageAutopilot(stageInput(keyed));
    expect(first.ok).toBe(true);

    const second = await src.stageAutopilot(stageInput(manual));
    expect(second.ok).toBe(false);
    if (!second.ok && second.kind === "conflict") {
      // `current` is null for THIS application — the live attempt lives on the
      // sibling row, exactly what the real conflict path re-reads.
      expect(second.current).toBeNull();
    } else {
      expect.fail("the sibling staging must be a conflict");
    }
  });

  it("a settled sibling releases the posting", async () => {
    const { src, keyed, manual } = sourceWithSibling();
    const first = await src.stageAutopilot(stageInput(keyed));
    if (!first.ok) return expect.fail("staging failed");
    await src.reviewAutopilotStage({
      stageId: first.stage.id,
      decision: "cancel",
      packageHash: null,
      reason: "",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    const second = await src.stageAutopilot(stageInput(manual));
    expect(second.ok && second.created).toBe(true);
  });

  it("a different posting at the same company is not a sibling", async () => {
    const keyedRow = FIXTURE_APPLICATIONS[0];
    const apps = [
      ...FIXTURE_APPLICATIONS.map((a) => ({ ...a })),
      { ...keyedRow, id: 102, postingKey: null, title: "Staff Engineer", url: null },
    ];
    const src = new FixtureDataSource(undefined, apps);
    const first = await src.stageAutopilot(stageInput(keyedRow.id));
    expect(first.ok).toBe(true);
    const second = await src.stageAutopilot(stageInput(102));
    expect(second.ok && second.created).toBe(true);
  });
});
