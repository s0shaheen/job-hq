/**
 * The resolve step, written once and wired twice.
 *
 * Both data sources call THIS function; they differ only in how a page is read
 * (the network, or a fixture table) and how an existing posting is looked up
 * (Postgres, or the in-memory store). Every rule the user can see — the
 * splitting, the keying, the provenance, the duplicate verdict, the order of
 * the results — is therefore the same in both modes by construction rather
 * than by a parity test noticing later that it stopped being.
 */
import { jobKey } from "@/lib/import/job-key";
import type { ResolvedLink } from "@/lib/data/source";
import { absoluteUrl, splitEntries, UNREADABLE } from "./links";
import { parsePosting } from "./parse";
import type { PageRead } from "./fetch";

export type ResolveDeps = {
  /** Read one page. Never throws: a failure is a `PageRead` with a reason. */
  readPage(url: string): Promise<PageRead>;
  /** The posting this user already tracks under `key`, or null. */
  existing(key: string): Promise<{ key: string; company: string; title: string } | null>;
};

/** Free text can never be fetched, so it is never reported as unfetchable. */
const TYPED_IN = "Not a link, so there was nothing to read. Fill it in below.";

export async function resolveJobLinks(pasted: string, deps: ResolveDeps): Promise<ResolvedLink[]> {
  const entries = splitEntries(pasted);
  const out: ResolvedLink[] = [];

  for (const entry of entries) {
    if (entry.kind === "text") {
      out.push({
        url: "",
        entered: entry.text,
        key: "",
        // The typed string goes in the TITLE slot and nowhere else. Deciding
        // that "Ramp, Product Manager" is a company and a role means splitting
        // on a comma the user may have meant as punctuation, and the surface
        // has two labelled fields for the user to put them in themselves.
        company: null,
        title: { value: entry.text, from: "as you typed it" },
        unreadable: TYPED_IN,
        duplicate: null,
      });
      continue;
    }

    const url = absoluteUrl(entry.url);
    if (url == null) {
      out.push({
        url: entry.url,
        entered: entry.url,
        key: "",
        company: null,
        title: null,
        unreadable: UNREADABLE,
        duplicate: null,
      });
      continue;
    }

    const page = await deps.readPage(url);
    const parsed = parsePosting(url, page.html);
    // Keyed on the URL AS PASTED, not on the redirect target: `jobKey` is the
    // identity the engine will mint for the same link when it scans, and the
    // engine sees the link, not the hop.
    const key = jobKey({ url, company: parsed.company?.value, title: parsed.title?.value });
    out.push({
      url,
      entered: entry.url,
      key,
      company: parsed.company,
      title: parsed.title,
      unreadable: page.unreadable,
      duplicate: key === "" ? null : await deps.existing(key),
    });
  }

  return out;
}
