/**
 * The three engine fields, filled in from the one thing a person types.
 *
 * The wizard used to ask for `role_family`, `board_search_term` and
 * `titles_include` separately and refuse to advance until all three were
 * answered. Two of those are the engine's vocabulary rather than anyone's:
 * `board_search_term` exists because Workday has no company list to walk, and
 * `titles_include` exists because the sweep matches on title text. Nobody
 * arriving at this app has an opinion about either.
 *
 * So they are derived from the role, visibly, into fields that stay editable.
 * The derivation is deliberately dumb — one title chip that is the role as
 * typed, one search word that is its first real word — because a person can
 * read a dumb rule off the screen and correct it. A clever one would be a guess
 * they cannot see.
 *
 * This is not `parseCriteria` filling blanks in from the committed baseline,
 * which is the bug `tests/unit/criteria.test.ts` exists for. That wrote
 * "product manager" over an answer somebody had given. This writes what they
 * typed, into fields they can see.
 */
import type { ProfileCriteria } from "./criteria";

/** Words that describe a level rather than a job, so a poor search keyword. */
const LEVEL_WORDS = new Set([
  "junior",
  "jr",
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "head",
  "chief",
  "associate",
  "assistant",
  "entry",
  "entry-level",
  "the",
  "a",
  "an",
  "of",
  "and",
]);

function normalize(role: string): string {
  return role.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The title list a role implies: the role itself, once.
 *
 * A posting reaches the queue when its title CONTAINS one of these, so "data
 * analyst" already catches "Senior Data Analyst" and "Data Analyst II". Adding
 * invented variants would be a guess with the same reach.
 */
export function titlesFromRole(role: string): string[] {
  const r = normalize(role);
  return r ? [r] : [];
}

/**
 * The one word the corpus-wide boards are searched for.
 *
 * First word of the role that names the work rather than the level, so "senior
 * financial analyst" searches for "financial" and not for "senior".
 */
export function boardTermFromRole(role: string): string {
  const words = normalize(role)
    .split(/[^a-z0-9&+]+/)
    .filter(Boolean);
  return words.find((w) => w.length >= 3 && !LEVEL_WORDS.has(w)) ?? words[0] ?? "";
}

/**
 * Is this title list still the one the role produced?
 *
 * Answered against the role the list was derived FROM, so the caller passes the
 * old role when the role is what changed. An empty list counts as derived: a
 * profile with no titles matches nothing, so "I cleared it" and "I have not
 * typed one yet" want the same repair.
 */
export function titlesAreDerived(titles: string[], role: string): boolean {
  if (titles.length === 0) return true;
  if (titles.length > 1) return false;
  return normalize(titles[0]) === normalize(role);
}

/**
 * Fill the engine's three fields from the role, without touching an answer.
 *
 * Run before the preview and before the save, so the numbers a person is shown
 * are computed over exactly the profile that gets stored.
 */
export function withDerivedDefaults(c: ProfileCriteria): ProfileCriteria {
  const role = c.role_family.trim();
  if (!role) return c;
  return {
    ...c,
    tag_domain: c.tag_domain.trim() || role,
    board_search_term: c.board_search_term.trim() || boardTermFromRole(role),
    titles_include: c.titles_include.length ? c.titles_include : titlesFromRole(role),
  };
}
