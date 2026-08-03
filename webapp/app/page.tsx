import { redirect } from "next/navigation";
import { landingPath } from "@/lib/display/prefs";
import { shellDisplayPrefs } from "@/lib/display/server";

export const dynamic = "force-dynamic";

/**
 * `/` — the front door, which is now the landing-view preference's one consumer.
 *
 * It used to be a hardcoded `redirect("/queue")` with the comment "the queue is
 * home". That was true until Settings started offering a Landing view select,
 * at which point a preference the app stored and nothing read would have been a
 * control that changes a row and nothing else — the exact defect this repo
 * records as "copy promising unwired behaviour". So the door reads the
 * preference and the preference decides.
 *
 * `landingPath` falls back to `/queue` for an absent or unrecognised value, so
 * an account that never touched the setting lands exactly where it always did.
 * `shellDisplayPrefs` itself fails open to the defaults, which means a store
 * that is down sends people to the queue rather than to an error page.
 *
 * MIDDLEWARE SENDS AN AUTHENTICATED VISITOR HERE rather than straight to
 * `/queue`, which is what makes this reachable on the path the preference
 * describes ("the page that opens when you sign in"). It costs one extra
 * redirect on the sign-in hop and nothing at all afterwards.
 *
 * There is no public landing page at this address. `Landing.dc.html` composes
 * one, and ADD-021 blocks it: its third crop and its whole trust section are the
 * Gmail status loop that DEC-002 excludes, and its pricing table is commercial
 * lifecycle that ADD-006 has not approved. A signed-out visitor is sent to
 * `/login` by the middleware gate, as before.
 */
export default async function Home() {
  const prefs = await shellDisplayPrefs();
  redirect(landingPath(prefs.landingView));
}
