"use server";

import { getDataSource } from "@/lib/data/get-source";
import type { ExportDataset } from "./scope";

/**
 * Row counts for the export dialog.
 *
 * These are read when the dialog opens rather than passed down from the page,
 * because the number the dialog states has to be the number the file contains.
 * A count captured at page load goes stale the moment a card is triaged, and a
 * dialog that promises 20 rows and delivers 14 is exactly the kind of small
 * lie that makes someone stop trusting an export.
 */
export type ExportCounts = { view: number; all: number };

export async function exportCountsAction(dataset: ExportDataset): Promise<ExportCounts> {
  const src = await getDataSource();
  if (dataset === "applications") {
    // The pipeline has no filters yet, so its view is everything. Reporting
    // one number twice is honest; inventing a distinction would not be.
    const n = (await src.applications()).length;
    return { view: n, all: n };
  }
  const [view, all] = await Promise.all([src.queue({ limit: 999 }), src.jobs()]);
  return { view: view.length, all: all.length };
}
