import { beforeEach, describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_APPLICATIONS, FIXTURE_JOBS } from "@/lib/data/fixtures";
import type { AppWriteResult } from "@/lib/data/source";
import type { ApplicationView } from "@/lib/data/view-models";

/**
 * The pipeline write path, over the fake.
 *
 * The fake's job is to reproduce migration 0010's failure modes, not its happy
 * path — this project has been bitten four times by a fake kinder than the real
 * thing. So every rule the SQL enforces is asserted here too, and the ones that
 * produce a message the user sees are additionally pinned to the SQL text in
 * `parity.test.ts`. The db suite (`tests/db/test_pipeline.py`) proves the same
 * rules against real Postgres; if these two ever disagree, one of them is lying.
 */

const APPS = {
  stripeInterview: 1,
  plaidSuggestion: 2,   // Applied + suggests Rejected
  anthropicApplied: 3,
  rampQueued: 4,
  datadogRejected: 5,   // terminal — Reopen is reachable
  affirmDelisted: 6,    // its posting is Closed
  brexInvented: 7,      // invented status, statusActor: "user"
} as const;

let src: FixtureDataSource;
let seq = 0;
const idem = () => `test-key-${++seq}`;

beforeEach(() => {
  src = new FixtureDataSource();
  seq = 0;
});

async function get(id: number): Promise<ApplicationView> {
  const row = (await src.applications()).find((a) => a.id === id);
  if (!row) throw new Error(`no fixture application ${id}`);
  return row;
}

/** Narrow to the success branch, failing loudly with the reason otherwise. */
function ok(result: AppWriteResult): ApplicationView {
  if (!result.ok) throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
  return result.application;
}

describe("setStatus", () => {
  it("applies the status and claims the row against later bot writes", async () => {
    const before = await get(APPS.anthropicApplied);
    expect(before.statusActor).toBe("system");

    const after = ok(
      await src.setStatus({
        applicationId: before.id,
        status: "Interview",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );

    expect(after.status).toBe("Interview");
    expect(after.statusActor).toBe("user");
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  it("clears a suggestion, because choosing a status answers it", async () => {
    // Otherwise the row reads "Interview · suggests Rejected" forever, beside a
    // status the human just chose themselves.
    const before = await get(APPS.plaidSuggestion);
    expect(before.suggestedStatus).toBe("Rejected");

    const after = ok(
      await src.setStatus({
        applicationId: before.id,
        status: "Interview",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.suggestedStatus).toBeNull();
  });

  it("accepts an invented status", async () => {
    // The sheet allows one and statusRank ranks it highest by construction.
    const before = await get(APPS.anthropicApplied);
    const after = ok(
      await src.setStatus({
        applicationId: before.id,
        status: "waiting on referral",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.status).toBe("waiting on referral");
  });

  it("refuses an empty, whitespace-only or oversized status before any write", async () => {
    const before = await get(APPS.anthropicApplied);
    // "\n\t" is here on purpose: SQL's bare btrim() trims spaces only, so this
    // exact value passed every emptiness check in the first draft of 0010.
    for (const bad of ["", "   ", "\n\t", "x".repeat(81)]) {
      const res = await src.setStatus({
        applicationId: before.id,
        status: bad,
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await get(APPS.anthropicApplied)).status).toBe(before.status);
  });

  it("refuses a missing or oversized idempotency key", async () => {
    const before = await get(APPS.anthropicApplied);
    for (const key of ["", "k".repeat(201)]) {
      const res = await src.setStatus({
        applicationId: before.id,
        status: "Interview",
        idempotencyKey: key,
        expectedUpdatedAt: before.updatedAt,
      });
      expect(res.ok).toBe(false);
      if (!res.ok && res.kind === "error") expect(res.message).toMatch(/idempotency/i);
    }
  });

  it("reports an unknown application as an error, not a crash", async () => {
    const res = await src.setStatus({
      applicationId: 9999,
      status: "Interview",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(res.message).toMatch(/no such application/i);
  });

  it("writes nothing when the status is already what a human set", async () => {
    // 0003's no-op rule: the write bumps updatedAt, which is every other tab's
    // version token, so a gesture that changes nothing used to invalidate them.
    const first = ok(
      await src.setStatus({
        applicationId: APPS.anthropicApplied,
        status: "Interview",
        idempotencyKey: idem(),
        expectedUpdatedAt: null,
      }),
    );
    const second = ok(
      await src.setStatus({
        applicationId: APPS.anthropicApplied,
        status: "Interview",
        idempotencyKey: idem(),
        expectedUpdatedAt: first.updatedAt,
      }),
    );
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("still claims the lock when re-selecting a status a BOT set", async () => {
    // Not a no-op: the human is asserting "this one is mine now", and the lock
    // is the entire value of the gesture.
    const before = await get(APPS.anthropicApplied);
    expect(before.statusActor).toBe("system");
    const after = ok(
      await src.setStatus({
        applicationId: before.id,
        status: before.status,
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.statusActor).toBe("user");
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });
});

describe("reopen", () => {
  it("refuses a reopen with no note, and writes nothing", async () => {
    const before = await get(APPS.datadogRejected);
    for (const note of [undefined, null, "", "   ", "\n"]) {
      const res = await src.setStatus({
        applicationId: before.id,
        status: "Applied",
        note,
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      });
      expect(res.ok, JSON.stringify(note)).toBe(false);
      if (!res.ok && res.kind === "error") expect(res.message).toMatch(/note/i);
    }
    const after = await get(APPS.datadogRejected);
    expect(after.status).toBe("Rejected");
    // The flat column's backfilled note is the only one there — no reopen note
    // leaked through on a refused write.
    expect(after.noteCount).toBe(1);
  });

  it("reopens with a note and keeps the reason in the history", async () => {
    const before = await get(APPS.datadogRejected);
    const after = ok(
      await src.setStatus({
        applicationId: before.id,
        status: "Applied",
        note: "Recruiter emailed back",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.status).toBe("Applied");
    expect(after.latestNote?.body).toBe("Recruiter emailed back");
  });

  it("does not demand a note for an ordinary status change", async () => {
    // The positive control: the requirement must bind on a reopen and nowhere
    // else, or it is just a nuisance.
    const before = await get(APPS.anthropicApplied);
    expect(
      ok(
        await src.setStatus({
          applicationId: before.id,
          status: "Interview",
          idempotencyKey: idem(),
          expectedUpdatedAt: before.updatedAt,
        }),
      ).status,
    ).toBe("Interview");
  });

  it("does not treat one terminal state moving to another as a reopen", async () => {
    const before = await get(APPS.datadogRejected);
    expect(
      ok(
        await src.setStatus({
          applicationId: before.id,
          status: "Closed",
          idempotencyKey: idem(),
          expectedUpdatedAt: before.updatedAt,
        }),
      ).status,
    ).toBe("Closed");
  });
});

describe("resolveSuggestion", () => {
  it("confirm applies the suggestion and claims the row", async () => {
    const before = await get(APPS.plaidSuggestion);
    const after = ok(
      await src.resolveSuggestion({
        applicationId: before.id,
        decision: "confirm",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.status).toBe("Rejected");
    expect(after.suggestedStatus).toBeNull();
    expect(after.statusActor).toBe("user");
  });

  it("reject leaves the status and the actor completely alone", async () => {
    // Matrix row 42: a "no thanks" that quietly applies the thing it declined.
    // statusActor is asserted too — declining ONE suggestion is not a claim over
    // the row, and a later better-evidenced email should still advance it.
    const before = await get(APPS.plaidSuggestion);
    const after = ok(
      await src.resolveSuggestion({
        applicationId: before.id,
        decision: "reject",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.status).toBe("Applied");
    expect(after.suggestedStatus).toBeNull();
    expect(after.statusActor).toBe("system");
  });

  it("is free when there is nothing to resolve", async () => {
    // A second Confirm arriving after the first honestly means "already done".
    const row = await get(APPS.anthropicApplied);
    expect(row.suggestedStatus).toBeNull();
    const after = ok(
      await src.resolveSuggestion({
        applicationId: row.id,
        decision: "confirm",
        idempotencyKey: idem(),
        expectedUpdatedAt: row.updatedAt,
      }),
    );
    expect(after.status).toBe("Applied");
    expect(after.updatedAt).toBe(row.updatedAt);
  });

  it("refuses a decision outside the closed set", async () => {
    const res = await src.resolveSuggestion({
      applicationId: APPS.plaidSuggestion,
      // A server action is a public endpoint and this type is erased at runtime.
      decision: "maybe" as unknown as "confirm",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(false);
  });

  it("applies once when confirmed twice under the same key", async () => {
    const before = await get(APPS.plaidSuggestion);
    const key = idem();
    const first = ok(
      await src.resolveSuggestion({
        applicationId: before.id,
        decision: "confirm",
        idempotencyKey: key,
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    const second = ok(
      await src.resolveSuggestion({
        applicationId: before.id,
        decision: "confirm",
        idempotencyKey: key,
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(second).toEqual(first);
  });
});

describe("optimistic concurrency", () => {
  it("returns a conflict carrying the CURRENT row, not the one the client held", async () => {
    // Matrix rows 45/46: a toast alone leaves the stale value on screen. The UI
    // can only refresh to the server's value if the result carries it.
    const before = await get(APPS.anthropicApplied);
    src.simulateExternalEdit(before.id, { status: "Offer" });

    const res = await src.setStatus({
      applicationId: before.id,
      status: "Interview",
      idempotencyKey: idem(),
      expectedUpdatedAt: before.updatedAt,
    });

    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "conflict") {
      expect(res.current.status).toBe("Offer");
      expect(res.current.updatedAt).not.toBe(before.updatedAt);
    } else {
      throw new Error(`expected a conflict, got ${JSON.stringify(res)}`);
    }
    expect((await get(before.id)).status).toBe("Offer");
  });

  it("simulateExternalEdit moves the version token even with no patch", async () => {
    // The token moving IS the mechanism; a seam that patched fields without
    // bumping it would produce no conflict and the demo param would prove nothing.
    const before = await get(APPS.anthropicApplied);
    src.simulateExternalEdit(before.id);
    expect((await get(before.id)).updatedAt).not.toBe(before.updatedAt);
  });

  it("simulateExternalEdit on an unknown row is a no-op, not a throw", async () => {
    // It is reachable from a URL (`?demo=conflict:999`), so a bad number must
    // not 500 the page.
    expect(() => src.simulateExternalEdit(9999)).not.toThrow();
  });

  it("a null expected token means last-write-wins, knowingly", async () => {
    const before = await get(APPS.anthropicApplied);
    src.simulateExternalEdit(before.id, { status: "Offer" });
    expect(
      ok(
        await src.setStatus({
          applicationId: before.id,
          status: "Interview",
          idempotencyKey: idem(),
          expectedUpdatedAt: null,
        }),
      ).status,
    ).toBe("Interview");
  });

  it("replays a key rather than conflicting on it", async () => {
    // Ordering inside the fake: replay is checked BEFORE the version token. A
    // retry that already landed must return its result, not a conflict about a
    // write it made itself — the property every Retry action leans on.
    const before = await get(APPS.anthropicApplied);
    const key = idem();
    const first = ok(
      await src.setStatus({
        applicationId: before.id,
        status: "Interview",
        idempotencyKey: key,
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    const replay = await src.setStatus({
      applicationId: before.id,
      status: "Offer",              // different intent, same key
      idempotencyKey: key,
      expectedUpdatedAt: before.updatedAt,   // now stale
    });
    expect(replay.ok).toBe(true);
    expect(ok(replay)).toEqual(first);
    expect((await get(before.id)).status).toBe("Interview");
  });
});

describe("failNextWrite", () => {
  it("turns the next pipeline write into an error and writes nothing", async () => {
    const before = await get(APPS.anthropicApplied);
    src.failNextWrite("Network unavailable");

    const res = await src.setStatus({
      applicationId: before.id,
      status: "Interview",
      idempotencyKey: idem(),
      expectedUpdatedAt: before.updatedAt,
    });

    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(res.message).toBe("Network unavailable");
    expect((await get(before.id)).status).toBe("Applied");
  });

  it("is consumed by one write, so the retry succeeds", async () => {
    const before = await get(APPS.anthropicApplied);
    src.failNextWrite();
    await src.setStatus({
      applicationId: before.id,
      status: "Interview",
      idempotencyKey: idem(),
      expectedUpdatedAt: before.updatedAt,
    });
    expect(
      ok(
        await src.setStatus({
          applicationId: before.id,
          status: "Interview",
          idempotencyKey: idem(),
          expectedUpdatedAt: before.updatedAt,
        }),
      ).status,
    ).toBe("Interview");
  });

  it("arms the suggestion and note paths too, not just setStatus", async () => {
    // `failNextWrite` sat with ZERO callers once already (matrix row 99). A
    // mechanism the matrix counts has to reach every write it claims to cover.
    src.failNextWrite();
    expect(
      (
        await src.resolveSuggestion({
          applicationId: APPS.plaidSuggestion,
          decision: "confirm",
          idempotencyKey: idem(),
          expectedUpdatedAt: null,
        })
      ).ok,
    ).toBe(false);

    src.failNextWrite();
    expect(
      (
        await src.addNote({
          applicationId: APPS.plaidSuggestion,
          body: "should not land",
          idempotencyKey: idem(),
        })
      ).ok,
    ).toBe(false);
    expect((await get(APPS.plaidSuggestion)).noteCount).toBe(0);
  });
});

describe("setNextAction", () => {
  it("round-trips text and date", async () => {
    const before = await get(APPS.plaidSuggestion);
    const after = ok(
      await src.setNextAction({
        applicationId: before.id,
        nextAction: "Prep the ledger case study",
        nextActionDate: "2026-08-01",
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.nextAction).toBe("Prep the ledger case study");
    expect(after.nextActionDate).toBe("2026-08-01");
  });

  it("writes nothing when a blur lands on an unchanged field", async () => {
    // Saved on blur, so this fires constantly. Without the short circuit,
    // tabbing through the pipeline bumps every row's token.
    const before = await get(APPS.stripeInterview);
    const after = ok(
      await src.setNextAction({
        applicationId: before.id,
        nextAction: before.nextAction ?? "",
        nextActionDate: before.nextActionDate,
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("clears to null rather than storing an empty string", async () => {
    const before = await get(APPS.stripeInterview);
    const after = ok(
      await src.setNextAction({
        applicationId: before.id,
        nextAction: "  ",
        nextActionDate: null,
        idempotencyKey: idem(),
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(after.nextAction).toBeNull();
    expect(after.nextActionDate).toBeNull();
  });

  it("refuses an oversized next action", async () => {
    const res = await src.setNextAction({
      applicationId: APPS.stripeInterview,
      nextAction: "x".repeat(501),
      nextActionDate: null,
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(false);
  });
});

// ------------------------------------------------------------------ AC 11

describe("acceptance criterion 11 — a bot-advanced application survives un-triage", () => {
  it("keeps an application the bot has moved past Queued", async () => {
    // The rule lives in setTriage's `status === "Queued"` filter, and it was
    // untested. `greenhouse-4410982` (Stripe) is at Interview in the fixture
    // set, so un-triaging its posting must leave the row alone.
    const posting = FIXTURE_JOBS.find((j) => j.key === "greenhouse-4410982");
    expect(posting, "fixture posting missing — the assertion below is vacuous").toBeTruthy();

    const res = await src.setTriage({
      postingKey: "greenhouse-4410982",
      triage: "",
      idempotencyKey: idem(),
      expectedUpdatedAt: posting!.updatedAt,
    });
    expect(res.ok).toBe(true);

    const still = (await src.applications()).find((a) => a.id === APPS.stripeInterview);
    expect(still?.status).toBe("Interview");
  });

  it("removes a still-Queued one, which is the positive control", async () => {
    // Without this, the rule could be "never delete anything" and the test above
    // would still pass.
    const posting = FIXTURE_JOBS.find((j) => j.key === "greenhouse-8814021");
    await src.setTriage({
      postingKey: "greenhouse-8814021",
      triage: "",
      idempotencyKey: idem(),
      expectedUpdatedAt: posting!.updatedAt,
    });
    expect((await src.applications()).some((a) => a.id === APPS.rampQueued)).toBe(false);
  });
});

describe("the fixture set itself", () => {
  it("carries every row the pipeline's assertions need", () => {
    // A fixture set that lost one of these turns several tests above into
    // vacuous passes, so the shape is asserted rather than assumed.
    const byId = new Map(FIXTURE_APPLICATIONS.map((a) => [a.id, a]));
    expect(byId.get(APPS.plaidSuggestion)?.suggestedStatus).toBe("Rejected");
    expect(byId.get(APPS.rampQueued)?.status).toBe("Queued");
    expect(byId.get(APPS.datadogRejected)?.status).toBe("Rejected");
    expect(byId.get(APPS.brexInvented)?.statusActor).toBe("user");
    // The delisted row's posting must actually be Closed in FIXTURE_JOBS, or
    // nothing can assert the badge appears.
    const key = byId.get(APPS.affirmDelisted)?.postingKey;
    expect(FIXTURE_JOBS.find((j) => j.key === key)?.status).toBe("Closed");
  });

  it("gives every application a defined statusActor", () => {
    for (const a of FIXTURE_APPLICATIONS) {
      expect(["system", "user"], `application ${a.id}`).toContain(a.statusActor);
    }
  });
});
