"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type AddJobResult,
  type ResolveJobLinksResult,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { MAX_LINKS } from "@/lib/quickadd/links";
import { jobKey } from "@/lib/import/job-key";

/**
 * The only way a quick-add gesture reaches the store.
 *
 * Mirrors `pipeline/actions.ts` line for line, including the two decisions it
 * documents: the session check happens HERE and not in middleware, because an
 * action that gets a redirect where it expected a result loses the gesture; and
 * every field is validated at the boundary, because a server action is a public
 * HTTP endpoint and these input types are erased at runtime.
 *
 * Two actions, and only the second one writes. That split is deliberate: a
 * resolve is a slow, failure-prone READ over somebody else's website, and
 * nothing it returns is trusted — the write takes the fields the user confirmed
 * on screen, which may be corrections, and never the resolver's own output.
 */

const DEMO_EXPIRED_COOKIE = "hq_demo_session";

async function demoSessionExpired(): Promise<boolean> {
  if (!isDemoMode()) return false;
  try {
    return (await cookies()).get(DEMO_EXPIRED_COOKIE)?.value === "expired";
  } catch {
    return false;
  }
}

async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

/** What one paste may contain. Generous, bounded, and stated in one place. */
const MAX_PASTE = 8_000;
/**
 * The column widths the posting fields have to fit. `postings.company` and
 * `.title` are unbounded `text`, so this is not a database limit — it is the
 * point past which a field stops being a company name and starts being a
 * paragraph somebody pasted into the wrong box.
 */
const MAX_FIELD = 200;
/** `postings.url` holds it, but a browser will not follow one longer. */
const MAX_URL = 2_048;

/**
 * Resolve what was pasted: split, key, parse, and flag what is already tracked.
 *
 * Never throws to the client. A resolver that dies takes the paste box with it,
 * and the paste box holds the one thing the user cannot recreate — what they
 * pasted.
 */
export async function resolveLinksAction(pasted: unknown): Promise<ResolveJobLinksResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  if (typeof pasted !== "string") return { ok: false, kind: "error", message: "Malformed request." };
  if (pasted.length > MAX_PASTE) {
    return {
      ok: false,
      kind: "error",
      message: `That is more than ${MAX_LINKS} links. Import a file instead.`,
    };
  }
  try {
    return await (await getDataSource()).resolveJobLinks({ pasted });
  } catch {
    // The reason is deliberately not forwarded: it is a fetcher's message about
    // somebody else's website, and the surface has one honest thing to say.
    return { ok: false, kind: "error", message: "Couldn't read these links." };
  }
}

/**
 * What the client may send. Note what is NOT here: the KEY.
 *
 * The identity of a posting is computed on the server from the confirmed URL,
 * company and title, and never accepted from the browser. A client-supplied key
 * would let a caller attach its row to any posting in the shared `postings`
 * table by naming that posting's key — a write into somebody else's row shape,
 * arriving through the one field nobody looks at.
 */
export type AddJobRequest = {
  url: string;
  company: string;
  title: string;
  idempotencyKey: string;
};

function invalidAddInput(input: AddJobRequest): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 200) {
    return "Invalid idempotency key.";
  }
  if (typeof input.url !== "string" || input.url.length > MAX_URL) return "Invalid link.";
  if (typeof input.company !== "string" || input.company.length > MAX_FIELD) {
    return "That company name is too long.";
  }
  if (typeof input.title !== "string" || input.title.length > MAX_FIELD) {
    return "That title is too long.";
  }
  return null;
}

/**
 * Track one posting the user confirmed.
 *
 * `/queue` and `/jobs` are revalidated because the row lands in both; the
 * pipeline is not, because nothing here creates an application — a quick-added
 * posting is a decision the user has not made yet, exactly like one the scan
 * found, and pre-deciding it would put a row in Applications that nobody
 * triaged.
 */
export async function addJobAction(input: AddJobRequest): Promise<AddJobResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  const invalid = invalidAddInput(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const url = input.url.trim();
  const company = input.company.trim();
  const title = input.title.trim();
  // The same function the importer and the engine key on, over the fields the
  // user confirmed. A URL alone keys through its ATS; a typed-in row keys on
  // `norm-<company>|<title>`; neither together keys at all, and that is refused
  // rather than stored as a row nothing can ever match.
  const key = jobKey({ url, company, title });
  if (key === "") {
    return { ok: false, kind: "error", message: "Add a link, or a company and a title." };
  }

  const result = await (await getDataSource()).addJob({
    url,
    key,
    company,
    title,
    idempotencyKey: input.idempotencyKey,
  });
  if (result.ok) {
    revalidatePath("/queue");
    revalidatePath("/jobs");
  }
  return result;
}
