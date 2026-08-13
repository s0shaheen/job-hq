/**
 * Reading a page the USER named, from OUR server.
 *
 * This is the one place in the web app where a signed-in person supplies a URL
 * and the server fetches it. That is server-side request forgery by
 * construction, and the mitigations are not optional:
 *
 *   1. `http`/`https` only. `file:`, `gopher:` and friends are refused by
 *      scheme before anything resolves.
 *   2. The address check happens AT THE SOCKET, not before it. Checking a
 *      name's resolution and then handing the NAME to a fetcher is two
 *      resolutions — an attacker's DNS answers public for the first and
 *      `169.254.169.254` for the second (DNS rebinding), and the socket
 *      connects to the second. So the enforcement is a dispatcher whose
 *      `lookup` refuses any non-public address at connection time: the
 *      addresses it validates are, by construction, the addresses the socket
 *      may connect to. `isPrivateAddress` is the range check, pure so it can
 *      be tested against the ranges rather than against a live network; the
 *      per-hop `refuseNonPublic` pre-check remains as the cheap early refusal
 *      and as the only guard a test-injected `fetchImpl` passes through, but
 *      it is advisory — the dispatcher is the boundary.
 *   3. Redirects are followed BY HAND, three hops maximum, re-checking at
 *      every hop and carrying the same dispatcher to each. `fetch`'s own
 *      redirect following would resolve hop two inside undici, where nothing
 *      can inspect it.
 *   4. A timeout and a byte cap, because a page that never ends is a server
 *      that never answers.
 *
 * The failure mode is uniform on purpose: every refusal returns `null` html and
 * a plain reason. The surface then shows the honest empty form with the URL
 * kept, which is the same thing it shows for a 404 — a user has no use for the
 * difference between "we would not fetch that" and "that did not answer", and
 * the difference is exactly what an attacker probing the internal network is
 * asking the product to report.
 */
import { lookup } from "node:dns/promises";
import { lookup as lookupWithCallback } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { UNREADABLE } from "./links";

/** Long enough for a slow ATS, short enough that the dialog stays a dialog. */
const TIMEOUT_MS = 8_000;
/** A job posting's head is in the first few KB; nothing here needs more. */
const MAX_BYTES = 512 * 1024;
const MAX_HOPS = 3;

const UA = "JobHQ/1.0 (+https://job-hq.app; a user asked us to read this posting)";

/**
 * Is this address one the public internet cannot route to us from?
 *
 * Covers loopback, link-local (169.254.0.0/16 — the metadata address lives
 * here), the three RFC1918 blocks, CGNAT, and the IPv6 equivalents including
 * IPv4-mapped addresses, which are the standard bypass: `::ffff:127.0.0.1` is
 * loopback wearing a v6 hat.
 */
export function isPrivateAddress(address: string, family: number): boolean {
  const value = (address ?? "").trim().toLowerCase();
  if (value === "") return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    if (value === "::" || value === "::1") return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    return /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
  }
  const parts = value.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a >= 224) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

async function refuseNonPublic(url: URL): Promise<boolean> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return true;
    return addresses.some((a) => isPrivateAddress(a.address, a.family));
  } catch {
    return true;
  }
}

/**
 * The connection-time enforcement: a `lookup` for the dispatcher's connector,
 * so the addresses that pass `isPrivateAddress` are the addresses the socket
 * is handed — one resolution, checked and used, instead of one checked and a
 * second one used (the rebinding TOCTOU `refuseNonPublic` alone would leave).
 *
 * ANY private address in the answer refuses the whole answer, not just that
 * address: a record mixing one public and one private address is the attack,
 * not a network quirk. The DNS function is injectable for exactly one reason —
 * the refusal must be provable against a hostile answer without a live
 * network.
 */
type AddressEntry = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | AddressEntry[],
  family?: number,
) => void;

export function makeGuardedLookup(
  dnsLookup: typeof lookupWithCallback = lookupWithCallback,
): (
  hostname: string,
  options: { all?: boolean; family?: number | "IPv4" | "IPv6" },
  callback: LookupCallback,
) => void {
  return (hostname, options, callback) => {
    const family =
      options.family === 4 || options.family === "IPv4"
        ? (4 as const)
        : options.family === 6 || options.family === "IPv6"
          ? (6 as const)
          : (0 as const);
    dnsLookup(hostname, { all: true, family }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = (Array.isArray(addresses) ? addresses : []) as AddressEntry[];
      if (list.length === 0 || list.some((a) => isPrivateAddress(a.address, a.family))) {
        const refusal: NodeJS.ErrnoException = new Error(
          `refusing to connect to a non-public address for ${hostname}`,
        );
        refusal.code = "HQ_NONPUBLIC_ADDRESS";
        return callback(refusal, []);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * One agent for every posting read. `connect.lookup` is the guard above, so
 * no socket this module opens can reach an address the check did not pass.
 * Exported so the wiring test can assert THIS object rides every hop's
 * request — an agent constructed but not passed protects nothing.
 */
export const ssrfAgent = new Agent({ connect: { lookup: makeGuardedLookup() } });

/**
 * undici's own fetch, NOT the global: Next patches `globalThis.fetch` on the
 * server, and a patched fetch that drops the `dispatcher` option would
 * silently discard the one mitigation that closes the rebinding hole. The
 * cast is structural — undici's Response satisfies everything `readPosting`
 * reads from it.
 */
const defaultFetch = undiciFetch as unknown as typeof fetch;

export type PageRead = {
  /** The page's markup, or null when it could not be read. */
  readonly html: string | null;
  /** Plain, user-facing, and identical for every refusal. */
  readonly unreadable: string | null;
  /** The URL that actually answered, after redirects. */
  readonly finalUrl: string;
};

/**
 * Fetch a posting page under every guard above.
 *
 * `fetchImpl` exists so the unit tests drive redirect chains and byte caps
 * without a network, and for no other reason — production passes nothing.
 */
export async function readPosting(
  target: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<PageRead> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { html: null, unreadable: UNREADABLE, finalUrl: target };
  }

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (await refuseNonPublic(url)) {
      return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
    }
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: "manual",
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // The enforcement, on EVERY hop: the socket resolves through the
        // guarded lookup, so the address checked is the address dialled.
        // (`dispatcher` is undici's extension of RequestInit; the DOM lib
        // types do not know it, hence the cast.)
        ...({ dispatcher: ssrfAgent } as Record<string, unknown>),
      });
    } catch {
      return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
      try {
        url = new URL(location, url);
      } catch {
        return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
      }
      continue;
    }

    if (!response.ok) {
      return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
    }
    const type = response.headers.get("content-type") ?? "";
    if (type !== "" && !/text\/html|application\/xhtml/i.test(type)) {
      return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
    }
    const body = await response.text().catch(() => null);
    if (body == null) return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
    return { html: body.slice(0, MAX_BYTES), unreadable: null, finalUrl: url.toString() };
  }
  return { html: null, unreadable: UNREADABLE, finalUrl: url.toString() };
}
