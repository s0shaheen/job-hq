import type { FormField } from "@/lib/apply/types";

/**
 * The attachment seam: how a résumé reaches an application form.
 *
 * WHY THIS MODULE EXISTS, AND WHY IT IS SHAPED LIKE THIS
 *
 * `lib/apply/prepare.ts` gates every `kind === "file"` field to
 * `gap(field, "attachment")` before any answer layer runs, and a required gap
 * makes the whole form `blocked`. That is a true statement about where Prepare
 * stops — it names the file, it does not attach one — and it is the single
 * reason no real Greenhouse board reaches `ready`.
 *
 * This module is the other half, and it is deliberately **only types and pure
 * functions**. It holds no fetch, no Supabase client, and no database call, for
 * the same reason `prepare.ts` holds none: the engine must stay testable
 * without a network. `ResumeAttachmentSource` mirrors `BackedInference` exactly
 * — "a hook the caller supplies; the engine never constructs one" — so when the
 * apply branch wires this up, its diff is a type import and one call site, not
 * a rewrite of the resolver.
 *
 * THE ONE THING THIS SEAM MUST NOT CARE ABOUT is where the bytes came from. A
 * résumé the user rendered here and a PDF they dragged in from their desktop
 * are the same object to an application form. That is why `origin` is recorded
 * on the artifact and then never branched on outside the UI — a submit harness
 * that behaves differently for an upload would be a second code path nobody
 * exercises.
 */

/** What a stored résumé artifact is, as a file. Mirrors `resume_artifacts.kind`. */
export type ResumeArtifactKind = "pdf" | "docx" | "png" | "yaml";

/**
 * Where the bytes came from. Recorded because a rendered artifact is
 * REPRODUCIBLE from its version row and an uploaded one is not — which is what
 * decides whether it may ever be evicted (see `ResumeArtifactRetention`).
 * It is not an authorization input and nothing downstream may branch on it.
 */
export type ResumeArtifactOrigin = "rendered" | "uploaded";

/**
 * `cache` may be regenerated on demand and deleted at will — a preview PNG.
 * `permanent` may not: an upload has no source to re-derive it from, and a copy
 * that was actually SENT is not reliably reproducible even from its own YAML,
 * because `rendercv[full]==2.8` leaves the typesetter floating on `>=` and the
 * typesetter decides layout. "Re-render it" is not a restore path.
 */
export type ResumeArtifactRetention = "permanent" | "cache";

/**
 * A pointer to one stored artifact. Carries no bytes on purpose — this crosses
 * a server-action boundary and gets embedded in staged-form state, and a
 * megabyte of base64 riding along in React state is how a form surface becomes
 * unusable on a phone.
 */
export interface ResumeAttachmentRef {
  artifactId: number;
  origin: ResumeArtifactOrigin;
  kind: ResumeArtifactKind;
  /** The name the ATS should see. Not the storage key. */
  filename: string;
  byteSize: number;
  /** Lowercase hex, 64 chars. The submit harness re-checks it after retrieval. */
  sha256: string;
  /**
   * `{user_id}/{artifact_id}/{filename}`. The leading segment is the owner and
   * that is load-bearing: it is what the storage policy matches on, and what
   * `app_record_resume_artifact` refuses to write when it is not the caller.
   */
  storagePath: string;
}

/**
 * Layer "attach", as a hook the caller supplies — the exact shape of
 * `BackedInference`, for the exact reason.
 *
 * Returning `null` means "no artifact for this field", which leaves the
 * existing `attachment` gap in place. It must NEVER be used to satisfy a field
 * whose `kind` is not `"file"`; picking a résumé for a textarea is what
 * `resume_text` siblings are for, and that path already works through the
 * answer library.
 */
export type ResumeAttachmentSource = (
  field: FormField,
) => ResumeAttachmentRef | null;

/**
 * How the submit harness turns a ref into bytes. Declared here, implemented
 * against Supabase Storage elsewhere, so nothing in the pure path imports a
 * client.
 *
 * Both methods are owner-scoped by the storage policy, not by this interface —
 * an implementation that took a `userId` argument would be inviting a caller to
 * pass the wrong one. The session decides, the same way `auth.uid()` decides
 * everywhere else in this app.
 */
export interface ResumeArtifactStore {
  /** The bytes, for a harness that uploads them as multipart form data. */
  fetch(ref: ResumeAttachmentRef): Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
  /**
   * A short-lived URL, for a harness that hands the ATS a link instead.
   * `expiresInSeconds` is required rather than defaulted: an attachment URL
   * with a forgotten lifetime is a résumé on the open web.
   */
  signedUrl(ref: ResumeAttachmentRef, expiresInSeconds: number): Promise<string>;
}

/** Content types, pinned here so the harness and the storage upload agree. */
export const ARTIFACT_CONTENT_TYPE: Record<ResumeArtifactKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  yaml: "application/yaml",
};

/**
 * The provenance token that lands in `StagedField.source`.
 *
 * The review surface prints this string beside every filled value, so it has to
 * read as an explanation to a human, and it has to parse back. The existing
 * vocabulary is `answer:<key>` and `policy:<topic>@<company>`; this follows it.
 */
export function attachmentToken(ref: ResumeAttachmentRef): string {
  return `resume:${ref.origin}:${ref.artifactId}`;
}

/**
 * Parse a token back. Returns `null` for anything that is not one of ours —
 * including `resume:` prefixed junk, because a token that half-parses is worse
 * than one that does not parse at all.
 */
export function parseAttachmentToken(
  token: string,
): { origin: ResumeArtifactOrigin; artifactId: number } | null {
  const m = /^resume:(rendered|uploaded):(\d+)$/.exec(token);
  if (!m) return null;
  const artifactId = Number(m[2]);
  // `\d+` already excludes signs and decimals; this catches the overflow case,
  // where Number("99999999999999999999") silently becomes a float.
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) return null;
  return { origin: m[1] as ResumeArtifactOrigin, artifactId };
}

/**
 * The storage key for an artifact. One function so the writer, the policy and
 * the reader cannot disagree about the layout.
 *
 * `filename` is sanitized rather than trusted: it reaches here from an upload
 * form, and a `../` in it would climb out of the owner's prefix — which is the
 * only thing separating two users' files.
 */
export function artifactStoragePath(
  userId: string,
  artifactId: number,
  filename: string,
): string {
  return `${userId}/${artifactId}/${safeFilename(filename)}`;
}

/**
 * Reduce a filename to something that cannot traverse, cannot hide, and still
 * reads as the user's file. Anything outside the allowed set collapses to `-`;
 * a name that survives as empty becomes `resume`, because a blank final segment
 * makes the storage key a directory.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // A leading dot hides the file on every unix tool that lists one; a leading
    // dash is read as a flag by every command that later touches it.
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  return cleaned === "" ? "resume" : cleaned;
}

/**
 * The publish gate.
 *
 * WHY IT LIVES HERE AND NOT IN THE RENDERER: the render service reports a page
 * count and never refuses. A renderer that declines to show you the two-page
 * result is useless for fixing it — the picture IS the fix. Blocking is a
 * product decision and it belongs at the moment the artifact leaves the
 * building, which is publish/attach, not save and not preview.
 *
 * `pageTarget === 0` means no limit, and it is not a placeholder: RenderCV's own
 * audience includes academics, and a 4-page CV is a legitimate use of the same
 * tool. Hard-coding one page would hard-code a US early-career convention into
 * the product.
 */
export type PublishGate =
  | { ok: true }
  | {
      ok: false;
      reason: "over-page-target";
      pages: number;
      pageTarget: number;
      message: string;
    }
  | { ok: false; reason: "never-rendered"; message: string };

export function publishGate(
  pages: number | null,
  pageTarget: number,
): PublishGate {
  // Not "assume one page". A version that has never been rendered has no page
  // count, and treating unknown as passing is how an unrendered draft gets
  // attached to a real application.
  if (pages === null || !Number.isFinite(pages) || pages <= 0) {
    return {
      ok: false,
      reason: "never-rendered",
      message: "This version has not been rendered yet, so its length is unknown.",
    };
  }
  if (pageTarget === 0) return { ok: true };
  if (pages <= pageTarget) return { ok: true };
  return {
    ok: false,
    reason: "over-page-target",
    pages,
    pageTarget,
    message:
      `This renders ${pages} pages and the target is ${pageTarget}. ` +
      `Trim it, raise the target, or pick a denser theme.`,
  };
}

/**
 * The page-count delta for a theme switch, as a preflight.
 *
 * MEASURED, and the reason this function exists rather than a tooltip saying
 * "themes may differ": across the nine built-in themes, page count agrees while
 * content is comfortably under or over a page, and diverges precisely in the
 * snug band — which is the band every one-page résumé lives in. On one neutral
 * fixture, five roles of four bullets rendered 1 page on `harvard` and `ink` and
 * 2 pages on the other seven. So the honest UI is: render both, show the delta,
 * then let the person choose.
 */
export interface ThemeDelta {
  theme: string;
  pages: number;
  /** Relative to the theme currently selected. */
  delta: number;
  /** Would this theme violate the document's target? */
  overTarget: boolean;
}

export function themeDeltas(
  probe: Record<string, number>,
  currentTheme: string,
  pageTarget: number,
): ThemeDelta[] {
  const current = probe[currentTheme];
  return Object.entries(probe)
    .map(([theme, pages]) => ({
      theme,
      pages,
      // `current` is absent when the caller probed a set that excludes the
      // theme in use. A delta against nothing is a lie, so it is 0 and the
      // absolute page count carries the meaning.
      delta: typeof current === "number" ? pages - current : 0,
      overTarget: pageTarget !== 0 && pages > pageTarget,
    }))
    .sort((a, b) => a.pages - b.pages || a.theme.localeCompare(b.theme));
}

/**
 * The nine built-in RenderCV themes, as of the pinned `rendercv==2.8`.
 *
 * DUPLICATED ON PURPOSE, in three places: here, the `resume_documents.theme`
 * CHECK constraint, and the render Lambda's own frozenset. It is not
 * belt-and-braces — the three defend different things. This one keeps a bad
 * value out of a form; the CHECK keeps it out of the database; the Lambda's is
 * the security control, because RenderCV resolves an unrecognised theme name as
 * a FILESYSTEM FOLDER and executes that folder's `__init__.py` during
 * validation. Only the last one is load-bearing against an attacker, and it is
 * the one that must never be removed for being redundant.
 */
export const BUILT_IN_THEMES = [
  "classic",
  "ember",
  "engineeringclassic",
  "engineeringresumes",
  "harvard",
  "ink",
  "moderncv",
  "opal",
  "sb2nov",
] as const;

export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];

export function isBuiltInTheme(theme: string): theme is BuiltInTheme {
  return (BUILT_IN_THEMES as readonly string[]).includes(theme);
}
