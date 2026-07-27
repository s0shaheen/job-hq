import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOCKOUT_TOPICS, POLICY_TOPICS } from "@/lib/apply/policy";

/**
 * The topic vocabulary exists twice. This is the mechanism that keeps it one.
 *
 * `db/migrations/0014_apply_answers.sql` declares the closed set in a CHECK
 * constraint (which is what makes an unknown topic unstorable) and the knockout
 * half again in `answer_policies_knockouts_are_human_authored` (which is what
 * makes a machine-authored knockout answer unstorable). `lib/apply/policy.ts`
 * declares both so the classifier and the resolver can reason about them.
 *
 * A comment saying "keep in step" is not a mechanism (matrix row 105). This
 * file PARSES THE MIGRATION, the way `status.test.ts` parses `core/schema.py`
 * and `parity.test.ts` parses 0008's `ALLOWED_SOURCES`.
 *
 * The two failures it exists to catch:
 *
 *   - a topic the classifier can produce and the store cannot hold — every rule
 *     the user writes for it fails to save, and the field silently stays a gap
 *     forever
 *   - a topic moved out of the SQL knockout list without being moved out of the
 *     TypeScript one, or the reverse — the resolver would refuse to guess a
 *     field the database is willing to store a guess for, or worse, the other
 *     way round
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const MIGRATION = readFileSync(
  path.join(REPO, "db", "migrations", "0014_apply_answers.sql"),
  "utf8",
);

/** Strip `--` comments, so a topic named in prose cannot satisfy this test. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * The quoted strings of a named constraint's topic list.
 *
 * `clause` has to be given rather than guessed: the knockout constraint's FIRST
 * `in (` is `provenance in ('user-entered','confirmed')`, and a parser that took
 * whichever list came first read the provenance vocabulary and called it the
 * knockout set. It went red the first time it ran, which is the only reason this
 * comment exists.
 */
function topicsInConstraint(name: string, clause = "topic in ("): string[] {
  const src = code(MIGRATION);
  const at = src.indexOf(name);
  expect(at, `${name} not found in the migration`).toBeGreaterThan(-1);
  const clauseAt = src.indexOf(clause, at);
  expect(clauseAt, `${name} has no \`${clause}\` clause`).toBeGreaterThan(-1);
  const open = src.indexOf("(", clauseAt + clause.length - 1);
  expect(open, `${name} has no IN list`).toBeGreaterThan(-1);
  // Balanced close of the `in (` list.
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `${name}'s IN list is unbalanced`).toBeGreaterThan(-1);
  return [...src.slice(open, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("the policy topic vocabulary is one set, in two languages", () => {
  it("the parser finds a list at all", () => {
    // Guards every assertion below from passing vacuously on an empty parse —
    // the failure that makes a drift guard worse than no guard.
    expect(topicsInConstraint("answer_policies_topic_is_known").length).toBeGreaterThan(10);
  });

  it("the SQL closed set and POLICY_TOPICS are the same, in the same order", () => {
    // Order too, not just membership: both lists are read by humans deciding
    // which half a topic belongs to, and a reordering that separates the six
    // knockouts from each other makes the SQL constraint below unreadable.
    expect(topicsInConstraint("answer_policies_topic_is_known")).toEqual([...POLICY_TOPICS]);
  });

  it("the SQL knockout list and KNOCKOUT_TOPICS are the same", () => {
    expect(
      topicsInConstraint("answer_policies_knockouts_are_human_authored", "topic not in ("),
    ).toEqual([...KNOCKOUT_TOPICS]);
  });

  it("every knockout topic is also in the closed set", () => {
    // Not implied by the two assertions above: a knockout topic missing from
    // the closed set would be a constraint guarding a value that can never be
    // stored, which reads as protection and is not.
    const all = new Set(topicsInConstraint("answer_policies_topic_is_known"));
    for (const t of topicsInConstraint(
      "answer_policies_knockouts_are_human_authored",
      "topic not in (",
    )) {
      expect(all.has(t), `${t} is a knockout but not a storable topic`).toBe(true);
    }
  });

  it("reads the constraint's code and not its prose", () => {
    // The stripper is itself load-bearing: 0014's header paragraph names
    // 'work_authorization' in a comment, and a parser that saw comments could
    // be satisfied by a rewording. Proven by pointing it at a comment-only
    // fixture rather than by trusting the regexp.
    expect(code("-- check (topic in ('bogus_topic'))\nselect 1;")).not.toContain("bogus_topic");
  });
});

describe("the provenance vocabulary is one set too", () => {
  it("matches the three values 0014 stores", () => {
    const provenances = [
      ...code(MIGRATION).matchAll(/provenance in \(([^)]*)\)/g),
    ].map((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
    expect(provenances.length).toBeGreaterThan(0);
    // The closed set, and the human-authored subset the two knockout checks use.
    expect(provenances).toContainEqual(["user-entered", "confirmed", "suggested"]);
    expect(provenances).toContainEqual(["user-entered", "confirmed"]);
  });
});
