"use server";

import { revalidatePath } from "next/cache";
import { getDataSource } from "@/lib/data/get-source";
import type { TriageInput, WriteResult } from "@/lib/data/source";

/**
 * The only way a triage decision reaches the store.
 *
 * It is a server action rather than a client-side insert because the browser
 * deliberately has no write permission (db/migrations/0001_init.sql ends by
 * saying so). Everything that makes a write safe lives on this side: the
 * idempotency key that makes a double-tap free, and the `expectedUpdatedAt`
 * that turns a second device into a visible conflict instead of a silent
 * clobber.
 */
export async function setTriageAction(input: TriageInput): Promise<WriteResult> {
  const src = await getDataSource();
  const result = await src.setTriage(input);
  if (result.ok) {
    // Only the pipeline is revalidated. The queue is a working set the user is
    // walking through: refetching it after every decision would reorder cards
    // under their cursor and fight the optimistic update. It is re-read on the
    // next visit, which is when a fresh list is actually wanted.
    revalidatePath("/pipeline");
  }
  return result;
}
