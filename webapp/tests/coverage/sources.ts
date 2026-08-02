/**
 * The three axes of the coverage cell (`17-ui-verification-standard.md` §2) are
 * DERIVED, never retyped. Surfaces come from the design source manifest, states
 * from the parity standard's §5 table, ADD items from the manifest's addenda
 * block. If a surface is added upstream, or a state row is added to §5, the
 * ledger grows a hole on the next run rather than silently staying green — which
 * is the entire point of a coverage gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const WEBAPP_ROOT = resolve(here, "..", "..");

const MANIFEST_PATH = resolve(
  REPO_ROOT,
  "docs/pilot-launch/evidence/design-source-manifest.json",
);
const PARITY_PATH = resolve(REPO_ROOT, "docs/pilot-launch/04-design-parity-standard.md");
const DAR_PATH = resolve(REPO_ROOT, "docs/pilot-launch/07-decisions-assumptions-risks.md");

export type Mode = "fixture" | "live";

/** A capability that works in only one mode is a defect, not a coverage detail. */
export const MODES: readonly Mode[] = ["fixture", "live"] as const;

export interface SurfaceSource {
  readonly surface: string;
  readonly status: string;
  readonly blockingAddenda: readonly string[];
  readonly advisoryAddenda: readonly string[];
}

interface ManifestSurface {
  surface: string;
  status: string;
  blocking_addenda?: string[];
  advisory_addenda?: string[];
}

interface ManifestAddendum {
  id: string;
  status: string;
  summary: string;
  packets?: string;
}

interface Manifest {
  surfaces: ManifestSurface[];
  addenda: Record<string, ManifestAddendum>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** The twelve surfaces, in manifest order. */
export function loadSurfaces(): SurfaceSource[] {
  const manifest = readManifest();
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length === 0) {
    throw new Error(`no surfaces in ${MANIFEST_PATH}`);
  }
  return manifest.surfaces.map((s) => ({
    surface: s.surface,
    status: s.status,
    blockingAddenda: s.blocking_addenda ?? [],
    advisoryAddenda: s.advisory_addenda ?? [],
  }));
}

export interface Addendum {
  readonly id: string;
  readonly status: string;
  readonly summary: string;
}

/**
 * ADD items known to BOTH the manifest and `07-decisions-assumptions-risks.md`.
 * A `blocked` verdict must name one; requiring the prose document to mention it
 * too stops the ledger citing an ADD id that no owner ever wrote down.
 */
export function loadAddenda(): Map<string, Addendum> {
  const manifest = readManifest();
  const dar = readFileSync(DAR_PATH, "utf8");
  const out = new Map<string, Addendum>();
  for (const [id, a] of Object.entries(manifest.addenda ?? {})) {
    if (!dar.includes(id)) continue;
    out.set(id, { id, status: a.status, summary: a.summary });
  }
  if (out.size === 0) throw new Error("no ADD items shared by the manifest and 07-*.md");
  return out;
}

/**
 * The required states, parsed out of the `04-design-parity-standard.md` §5
 * table. §5 is authoritative and this file does not redefine it — it reads it.
 */
export function loadStates(): string[] {
  const md = readFileSync(PARITY_PATH, "utf8");
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^## 5\. Required state inventory\s*$/.test(l));
  if (start < 0) throw new Error(`§5 heading not found in ${PARITY_PATH}`);
  const end = lines.findIndex((l, i) => i > start && /^## \d/.test(l));
  const body = lines.slice(start, end < 0 ? lines.length : end);

  const states: string[] = [];
  for (const line of body) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const name = cells[1] ?? "";
    if (!name || name === "State" || /^-+$/.test(name)) continue;
    states.push(name);
  }
  if (states.length === 0) throw new Error(`no state rows parsed from ${PARITY_PATH} §5`);
  return states;
}

export function cellKey(surface: string, state: string, mode: Mode): string {
  return `${surface} | ${state} | ${mode}`;
}
