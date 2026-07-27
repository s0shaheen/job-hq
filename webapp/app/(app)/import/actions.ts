"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import { isDemoMode } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { MAPPABLE_FIELDS } from "@/lib/import/map-columns";
import { isWritableColumn, WRITABLE_COLUMNS } from "@/lib/import/round-trip";
import { MAX_ROWS } from "@/lib/import/read";
import type { ImportBatchView, ImportCounts } from "@/lib/import/views";
import { isCanonicalStatus } from "@/lib/status";
import { headersOf, mapRows, unmappedFor, NO_HEADER_ROW } from "./prepare";

/**
 * Every mutating step of the import wizard, and nothing else.
 *
 * Same shape as `pipeline/actions.ts`, for the same two reasons it records:
 *
 *   * **The session check happens HERE.** Middleware answers an expired session
 *     with a redirect, which is right for a navigation and useless for an action
 *     — the browser gets a redirect where it expected a result and the gesture
 *     evaporates.
 *   * **Every payload is validated at the boundary.** A server action is a public
 *     HTTP endpoint and these input types are erased at runtime, so "the client
 *     only ever sends a valid field name" is not a fact about the system (matrix
 *     row 38). Field names are checked against `MAPPABLE_FIELDS`, conflict
 *     choices against `mine|theirs`, conflict columns against `WRITABLE_COLUMNS`,
 *     every status against `lib/status.ts`, and every array is bounded.
 *
 * ## Which of these carry an idempotency key, and why not all of them
 *
 * `createImport`, `commitImportChunk` and `undoImport` take one, because each is a
 * command whose replay would otherwise apply twice — and the key is minted once
 * per GESTURE and reused by every retry of it (matrix row 136: a fresh
 * `randomUUID()` per retry makes a lost response a second command).
 *
 * `setImportMapping`, `previewImport`, `resolveImportRow` and
 * `setImportRowsIncluded` take none, and that is the data layer's design rather
 * than an omission: each overwrites a derived value with a value computed from
 * its arguments, so applying it twice is applying it once. A key would be
 * ceremony that implies a guarantee nothing needs.
 */

const DEMO_EXPIRED_COOKIE = "hq_demo_session";

/** Every refusal, in one shape, always with a sentence the UI can render. */
export type Refused = { ok: false; kind: "auth" | "conflict" | "error"; message: string };

export type MappingActionResult =
  | { ok: true; batch: ImportBatchView; counts: ImportCounts; unresolved: number }
  | Refused;
export type PreviewActionResult =
  | { ok: true; batch: ImportBatchView; counts: ImportCounts; unresolved: number }
  | Refused;
export type ResolveActionResult = { ok: true; unresolved: number } | Refused;
export type IncludeActionResult = { ok: true; rows: number } | Refused;
export type CommitActionResult =
  | {
      ok: true;
      batch: ImportBatchView;
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      remaining: number;
    }
  | Refused;
export type UndoActionResult =
  | {
      ok: true;
      batch: ImportBatchView;
      deleted: number;
      reverted: number;
      kept: number;
      keptIds: number[];
      notesKept: number;
    }
  | Refused;

const AUTH: Refused = {
  ok: false,
  kind: "auth",
  message: "Your session expired. Sign in and try that again.",
};

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

function refuse(message: string): Refused {
  return { ok: false, kind: "error", message };
}

/**
 * Auth first, then validation — the order `pipeline/actions.ts` explains: an
 * expired session with a malformed payload is reported as the expired session,
 * because that is the one the user can act on.
 */
async function guard(batchId: unknown, extra?: () => string | null): Promise<Refused | null> {
  if (await demoSessionExpired()) return AUTH;
  if (!(await hasSession())) return AUTH;
  if (typeof batchId !== "string" || !batchId || batchId.length > 100) {
    return refuse("That is not an import this app can find.");
  }
  const invalid = extra?.() ?? null;
  return invalid ? refuse(invalid) : null;
}

/** A finite, non-negative, safe integer — not merely `typeof "number"`. */
function isIndex(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounds that exist so a malformed request is a message, not a Postgres error. */
const MAX_COLUMNS = 1000;
const MAX_STATUS_ENTRIES = 500;
const MAX_STATUS_WORD = 200;
/** `app_import_set_included`'s own fan-out bound. */
const MAX_INCLUDE_ROWS = 5000;
/** `app_import_commit_chunk` clamps to this whatever is sent; refuse first. */
const MAX_COMMIT_LIMIT = 500;

export type SetMappingInput = {
  batchId: string;
  /** 0-based SOURCE position of the header row, or `-1` for "every row is data". */
  headerRowIndex: number;
  /** Target field → 0-based column index. A missing key is Unmapped. */
  columnMap: Record<string, number>;
  /** The file's status word → one of ours. */
  statusMap: Record<string, string>;
  expectedUpdatedAt: string | null;
};

/**
 * Write the mapping, then say what committing it would do.
 *
 * Three store calls in one gesture, deliberately: the mapping (chunked, `final`
 * on the last), the exclusion of the header row and anything above it, and the
 * preview. They are one gesture because a batch that is `mapped` but not
 * `previewed` renders the mapping screen again — `importStep` puts `uploaded` and
 * `mapped` on the same step — so stopping in between would leave the user on a
 * screen they had just finished with no forward control.
 *
 * The chunk size is `app_import_set_mapping`'s own MAX_CHUNK. `expectedUpdatedAt`
 * is checked on the final call only, which is the function's contract: the chunks
 * are one gesture, and re-checking each would turn a ten-chunk mapping into ten
 * chances to lose a race with yourself.
 */
const MAPPING_CHUNK = 1000;

export async function setImportMappingAction(
  input: SetMappingInput,
): Promise<MappingActionResult> {
  const refused = await guard(input?.batchId, () => {
    if (!isPlainObject(input)) return "Malformed request.";
    if (
      typeof input.headerRowIndex !== "number" ||
      !Number.isSafeInteger(input.headerRowIndex) ||
      input.headerRowIndex < NO_HEADER_ROW ||
      input.headerRowIndex > MAX_ROWS
    ) {
      return "That is not a row this file has.";
    }
    if (!isPlainObject(input.columnMap)) return "Malformed column mapping.";
    const entries = Object.entries(input.columnMap);
    if (entries.length > MAPPABLE_FIELDS.length) return "Malformed column mapping.";
    for (const [field, index] of entries) {
      // The closed set. A field name is not free text: the commit path reads
      // `mapped` by key, so an unknown key is a column silently not imported.
      if (!(MAPPABLE_FIELDS as readonly string[]).includes(field)) {
        return `${field} is not a field an import can write.`;
      }
      if (!isIndex(index, MAX_COLUMNS)) return `${field} is mapped to something that is not a column.`;
    }
    if (!isPlainObject(input.statusMap)) return "Malformed status mapping.";
    const statuses = Object.entries(input.statusMap);
    if (statuses.length > MAX_STATUS_ENTRIES) {
      return `That is ${statuses.length} status values; the limit is ${MAX_STATUS_ENTRIES}.`;
    }
    for (const [word, status] of statuses) {
      if (typeof word !== "string" || word.length > MAX_STATUS_WORD) return "Malformed status mapping.";
      // The vocabulary is closed to `lib/status.ts`. A spreadsheet cell may not
      // mint a status — an invented one outranks everything and freezes the row
      // against the engine forever (matrix row 43).
      if (typeof status !== "string" || !isCanonicalStatus(status)) {
        return `${String(status)} is not a status this app has.`;
      }
    }
    if (input.expectedUpdatedAt != null && typeof input.expectedUpdatedAt !== "string") {
      return "Invalid version token.";
    }
    return null;
  });
  if (refused) return refused;

  const source = await getDataSource();
  const found = await source.importBatch(input.batchId);
  if (!found) return refuse("That import is not one of yours, or it is gone.");

  const headers = headersOf(found.rows, input.headerRowIndex);
  for (const [field, index] of Object.entries(input.columnMap)) {
    if (index >= headers.length) {
      return refuse(`${field} is mapped to a column this file does not have.`);
    }
  }

  const { rows, excluded } = mapRows(
    found.rows,
    input.headerRowIndex,
    input.columnMap,
    input.statusMap,
  );

  for (let at = 0; at < rows.length; at += MAPPING_CHUNK) {
    const chunk = rows.slice(at, at + MAPPING_CHUNK);
    const final = at + MAPPING_CHUNK >= rows.length;
    const written = await source.setImportMapping({
      batchId: input.batchId,
      rows: chunk,
      mapping: {
        headers,
        headerRowIndex: input.headerRowIndex,
        columnMap: input.columnMap,
        statusMap: input.statusMap,
        roundTrip:
          input.columnMap.hqId !== undefined && input.columnMap.hqVersion !== undefined,
        unmapped: unmappedFor(headers, input.columnMap),
      },
      final,
      expectedUpdatedAt: final ? input.expectedUpdatedAt : null,
    });
    if (!written.ok) {
      if (written.kind === "auth") return AUTH;
      if (written.kind === "conflict") {
        return {
          ok: false,
          kind: "conflict",
          message: "This import was changed in another tab. Reload to see the mapping it has now.",
        };
      }
      return refuse(written.message);
    }
  }

  if (excluded.length > 0) {
    const held = await source.setImportRowsIncluded({
      batchId: input.batchId,
      rowNumbers: excluded.slice(0, MAX_INCLUDE_ROWS),
      included: false,
    });
    if (!held.ok) {
      if (held.kind === "auth") return AUTH;
      // Said out loud rather than swallowed: the mapping landed, and the row of
      // column names is still marked for import. Skipping it by hand on the next
      // screen is a real way out, so name it.
      return refuse(
        `The mapping was saved, but the header row could not be marked as skipped (${held.message}). Skip it on the review screen, or save the mapping again.`,
      );
    }
  }

  const preview = await source.previewImport(input.batchId);
  if (!preview.ok) return preview.kind === "auth" ? AUTH : refuse(preview.message);

  revalidatePath(`/import/${input.batchId}`);
  revalidatePath("/import");
  return { ok: true, batch: preview.batch, counts: preview.counts, unresolved: preview.unresolved };
}

/**
 * Re-decide what every row would do, against the pipeline as it is NOW.
 *
 * A real control rather than a spare wheel: a preview taken ten minutes ago
 * describes a pipeline that may have moved — a bot advanced a status, another tab
 * added the same job — and committing against a stale reading is how a row gets
 * inserted beside the one it should have updated. Writes nothing to
 * `applications`.
 */
export async function previewImportAction(batchId: string): Promise<PreviewActionResult> {
  const refused = await guard(batchId);
  if (refused) return refused;

  const result = await (await getDataSource()).previewImport(batchId);
  if (!result.ok) return result.kind === "auth" ? AUTH : refuse(result.message);
  revalidatePath(`/import/${batchId}`);
  return { ok: true, batch: result.batch, counts: result.counts, unresolved: result.unresolved };
}

export type ResolveInput = {
  batchId: string;
  rowNumber: number;
  choices: Record<string, "mine" | "theirs">;
};

/** Answer one conflicted round-trip row, cell by cell. */
export async function resolveImportRowAction(input: ResolveInput): Promise<ResolveActionResult> {
  const refused = await guard(input?.batchId, () => {
    if (!isPlainObject(input)) return "Malformed request.";
    if (
      typeof input.rowNumber !== "number" ||
      !Number.isSafeInteger(input.rowNumber) ||
      input.rowNumber <= 0
    ) {
      return "That is not a row in this import.";
    }
    if (!isPlainObject(input.choices)) return "Malformed choices.";
    const entries = Object.entries(input.choices);
    if (entries.length === 0) return "Nothing was chosen.";
    if (entries.length > WRITABLE_COLUMNS.length) return "Malformed choices.";
    for (const [column, choice] of entries) {
      // The five columns an import may write, and nothing else. The resolver can
      // only offer these, but the resolver is not the rule.
      if (!isWritableColumn(column)) return `${column} is not a column an import can write.`;
      if (choice !== "mine" && choice !== "theirs") {
        return `The choice for ${column} has to be yours or the file's.`;
      }
    }
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).resolveImportRow(input);
  if (!result.ok) return result.kind === "auth" ? AUTH : refuse(result.message);
  revalidatePath(`/import/${input.batchId}`);
  return { ok: true, unresolved: result.unresolved };
}

export type IncludeInput = { batchId: string; rowNumbers: number[]; included: boolean };

/** The preview's veto: keep a row out before anything is written. */
export async function setImportRowsIncludedAction(
  input: IncludeInput,
): Promise<IncludeActionResult> {
  const refused = await guard(input?.batchId, () => {
    if (!isPlainObject(input)) return "Malformed request.";
    if (typeof input.included !== "boolean") return "Malformed request.";
    if (!Array.isArray(input.rowNumbers) || input.rowNumbers.length === 0) {
      return "No rows were named.";
    }
    if (input.rowNumbers.length > MAX_INCLUDE_ROWS) {
      return `That is ${input.rowNumbers.length} rows in one gesture; the limit is ${MAX_INCLUDE_ROWS}.`;
    }
    for (const n of input.rowNumbers) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
        return "That is not a row in this import.";
      }
    }
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).setImportRowsIncluded(input);
  if (!result.ok) return result.kind === "auth" ? AUTH : refuse(result.message);
  revalidatePath(`/import/${input.batchId}`);
  return { ok: true, rows: result.staged };
}

export type CommitInput = { batchId: string; limit: number; idempotencyKey: string };

/**
 * Commit one chunk. Called in a loop until `remaining` is 0.
 *
 * Chunk-atomic and batch-reversible, which is the resolution of G12's "chunked,
 * resumable, batch-atomic": one 2,000-row transaction invites a statement timeout
 * and gives nothing back when it hits one, so each chunk is a transaction,
 * `committedCount` is the resume cursor, and undo is what makes a half-committed
 * batch recoverable in one gesture.
 */
export async function commitImportChunkAction(input: CommitInput): Promise<CommitActionResult> {
  const refused = await guard(input?.batchId, () => {
    if (!isPlainObject(input)) return "Malformed request.";
    if (
      typeof input.limit !== "number" ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_COMMIT_LIMIT
    ) {
      return `A chunk has to be between 1 and ${MAX_COMMIT_LIMIT} rows.`;
    }
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > 200
    ) {
      return "Invalid idempotency key.";
    }
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).commitImportChunk(input);
  if (!result.ok) return result.kind === "auth" ? AUTH : refuse(result.message);

  revalidatePath(`/import/${input.batchId}`);
  revalidatePath("/import");
  // The pipeline is where the imported rows appear, and it is a list edited in
  // place, so a re-read moves nothing under anybody's cursor.
  revalidatePath("/pipeline");
  return {
    ok: true,
    batch: result.batch,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    remaining: result.remaining,
  };
}

export type UndoInput = { batchId: string; idempotencyKey: string };

/**
 * Put the whole batch back (AC 21).
 *
 * The window is the SERVER's: `undoImport` reads `undo_expires_at` off the row and
 * refuses on its own, so a stale tab, a wrong client clock and a hand-made
 * request all get the same answer.
 */
export async function undoImportAction(input: UndoInput): Promise<UndoActionResult> {
  const refused = await guard(input?.batchId, () => {
    if (!isPlainObject(input)) return "Malformed request.";
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > 200
    ) {
      return "Invalid idempotency key.";
    }
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).undoImport(input);
  if (!result.ok) return result.kind === "auth" ? AUTH : refuse(result.message);

  revalidatePath(`/import/${input.batchId}`);
  revalidatePath("/import");
  revalidatePath("/pipeline");
  return {
    ok: true,
    batch: result.batch,
    deleted: result.deleted,
    reverted: result.reverted,
    kept: result.kept,
    keptIds: result.keptIds,
    notesKept: result.notesKept,
  };
}
