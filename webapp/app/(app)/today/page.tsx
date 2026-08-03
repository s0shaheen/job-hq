import { redirect } from "next/navigation";

/**
 * `/today` was the nav destination's placeholder while the surface was unbuilt.
 * The surface is built now, on `/queue` (see `components/ds/app-shell.tsx` for
 * why the route did not move), so this path exists only to keep a bookmark or
 * an old link from 404ing.
 *
 * A redirect rather than a second copy of the page: two routes rendering one
 * surface is two places for its reads, its metadata and its skeleton to drift.
 */
export default function TodayPage() {
  redirect("/queue");
}
