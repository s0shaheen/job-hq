/**
 * The connections fixture set — deterministic data for demo mode and the E2E
 * suite.
 *
 * Built to make the uncomfortable states REACHABLE, which is the lesson matrix
 * row 15 records and the one a comfortable fixture set always loses. Every row
 * here exists because some branch is otherwise unexercised:
 *
 *   - two people at one company, so "2 first-degree" is not the same render as
 *     "1 first-degree" and a popover that lists exactly one name cannot pass;
 *   - a company whose spelling differs from the posting's by a NON-BREAKING
 *     SPACE, which is what pasting out of a web page leaves and what makes
 *     `company_name_key` load-bearing rather than decorative — under `lower()`
 *     this row silently matches nothing;
 *   - a connection with NO profile URL, so the "search for them by name" branch
 *     of `connectionUrl` renders rather than shipping untested;
 *   - a connection whose exported URL is NOT a linkedin.com address, because a
 *     CSV cell is a place a `javascript:` string can live and the href guard has
 *     to have something to refuse;
 *   - a connection at a company nobody has an id for, so the names half and the
 *     links half of the popover are visibly independent;
 *   - a very long name and a very long title, for FIXTURE_JOBS' reason: long
 *     content truncates, it does not blow out the layout;
 *   - a null `connectedOn`, because LinkedIn's date column is "21 Mar 2023" and
 *     an unreadable one must render as absent rather than as today.
 */
import { companyNameKey, type ConnectionView } from "./view-models";

type Seed = Omit<ConnectionView, "companyKey"> & { companyKey?: string };

/**
 * `companyKey` is computed here from the SAME function the SQL column is
 * generated with, rather than typed by hand: a fixture that hand-typed the key
 * could hold one the database would never produce, and the match would pass in
 * the demo and fail in production.
 */
function connection(seed: Seed): ConnectionView {
  return { ...seed, companyKey: seed.companyKey ?? companyNameKey(seed.company) };
}

export const FIXTURE_CONNECTIONS: ConnectionView[] = [
  connection({
    id: 1,
    fullName: "Ada Okonkwo",
    company: "Ramp",
    title: "Senior Product Manager, Bill Pay",
    profileUrl: "https://www.linkedin.com/in/ada-okonkwo",
    connectedOn: "2024-03-11",
  }),
  connection({
    id: 2,
    fullName: "Bo Lindqvist",
    company: "Ramp",
    title: "Engineering Manager",
    // No URL: LinkedIn withholds it for connections who restricted it, and the
    // name-search fallback is the branch this row exists for.
    profileUrl: "",
    connectedOn: "2023-11-02",
  }),
  // The NBSP row. `Fifth Third Bank` here is spelled with U+00A0 between the
  // second and third words; the posting spells it with a plain space. They are
  // the same employer, and only `company_name_key` says so.
  //
  // The character is a LITERAL U+00A0 in the string below and it is invisible in
  // an editor. `connection-fixtures.test.ts` asserts it is still there by
  // codepoint, because the next person to touch this line will "tidy" it into a
  // plain space and quietly delete the only case that can tell
  // `company_name_key` from `lower()`.
  connection({
    id: 3,
    fullName: "Chandra Rao",
    company: "Fifth Third Bank",
    title: "VP, Digital Product",
    profileUrl: "https://www.linkedin.com/in/chandra-rao",
    connectedOn: "2022-06-30",
  }),
  // A URL that is not a LinkedIn address. The href guard must refuse it and fall
  // back to a name search — a CSV cell is user-supplied text, and rendering it
  // as an href would make somebody's spreadsheet a link on this origin.
  connection({
    id: 4,
    fullName: "Dev Patel",
    company: "Fifth Third Bank",
    title: "Product Owner",
    profileUrl: "https://example.invalid/not-linkedin",
    connectedOn: null,
  }),
  // A company with no universe row at all, so "names, but no company id" is
  // reachable from a second direction.
  connection({
    id: 5,
    fullName: "Eleni Papadopoulou-Constantinidis von Habsburg-Lothringen",
    company: "Anthropic",
    title:
      "Member of Technical Staff, Applied Research Infrastructure and Developer Experience Platform",
    profileUrl: "https://www.linkedin.com/in/eleni-p",
    connectedOn: "2025-01-19",
  }),
];
