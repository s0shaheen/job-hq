// UI model over the parsed cv YAML (client-side). Paths in ops always address
// the real YAML structure (cv.sections.<name>[i]...), so the model can stay a
// lossy view — the Document round-trip on the server is what actually edits.

import { parse } from "yaml";
import type { Op, PathSeg } from "./yamlops";

export type Bullet = { id: number; text: string };

export type FieldModel = { key: string; value: string };

export type EntryModel = {
  kind: "map" | "text";
  section: string; // YAML key under cv.sections
  index: number; // position within the section array
  title: string;
  subtitle: string;
  fields: FieldModel[]; // scalar fields in file order (map entries)
  text: string; // text entries only
  bullets: Bullet[] | null; // null = entry has no highlights array
};

export type SectionModel = { name: string; display: string; entries: EntryModel[] };
export type CvModel = { sections: SectionModel[] };

const TITLE_KEYS = ["company", "institution", "label", "name", "title"];
const SUBTITLE_KEYS = ["position", "area", "degree"];

export function sectionPath(section: string): PathSeg[] {
  return ["cv", "sections", section];
}

export function entryPath(e: { section: string; index: number }): PathSeg[] {
  return [...sectionPath(e.section), e.index];
}

export function highlightsPath(e: { section: string; index: number }): PathSeg[] {
  return [...entryPath(e), "highlights"];
}

function displayName(key: string): string {
  return key
    .split(/[_-]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** Parse YAML text into the UI model. Throws on YAML errors or a missing cv.sections. */
export function buildModel(source: string, nextId: () => number): CvModel {
  const root = parse(source) as { cv?: { sections?: Record<string, unknown> } } | null;
  const sections = root?.cv?.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
    throw new Error("no cv.sections mapping found — edit this file in the Raw tab");
  }
  const out: CvModel = { sections: [] };
  for (const [name, raw] of Object.entries(sections)) {
    if (!Array.isArray(raw)) continue; // section that isn't a list — Raw tab territory
    const entries: EntryModel[] = raw.map((item, index) => {
      if (item === null || typeof item !== "object") {
        return {
          kind: "text" as const,
          section: name,
          index,
          title: "",
          subtitle: "",
          fields: [],
          text: scalarToString(item),
          bullets: null,
        };
      }
      const rec = item as Record<string, unknown>;
      const fields: FieldModel[] = [];
      let bullets: Bullet[] | null = null;
      for (const [key, value] of Object.entries(rec)) {
        if (key === "highlights" && Array.isArray(value)) {
          bullets = value.map((t) => ({ id: nextId(), text: scalarToString(t) }));
        } else if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
          fields.push({ key, value: scalarToString(value) });
        }
        // nested collections other than highlights: invisible here, Raw tab handles them
      }
      const titleKey = TITLE_KEYS.find((k) => rec[k] !== undefined);
      const subKey = SUBTITLE_KEYS.find((k) => rec[k] !== undefined);
      return {
        kind: "map" as const,
        section: name,
        index,
        title: titleKey ? scalarToString(rec[titleKey]) : displayName(name),
        subtitle: subKey ? scalarToString(rec[subKey]) : "",
        fields,
        text: "",
        bullets,
      };
    });
    out.sections.push({ name, display: displayName(name), entries });
  }
  if (out.sections.length === 0) throw new Error("cv.sections has no list sections");
  return out;
}

// ---- immutable model updates that mirror ops (optimistic UI state) ----

function mapEntry(m: CvModel, section: string, index: number, fn: (e: EntryModel) => EntryModel): CvModel {
  return {
    sections: m.sections.map((s) =>
      s.name !== section ? s : { ...s, entries: s.entries.map((e) => (e.index === index ? fn(e) : e)) },
    ),
  };
}

export function modelSetField(m: CvModel, section: string, index: number, key: string, value: string): CvModel {
  return mapEntry(m, section, index, (e) => {
    const fields = e.fields.map((f) => (f.key === key ? { ...f, value } : f));
    const title = TITLE_KEYS.find((k) => fields.some((f) => f.key === k));
    const sub = SUBTITLE_KEYS.find((k) => fields.some((f) => f.key === k));
    return {
      ...e,
      fields,
      title: title ? fields.find((f) => f.key === title)!.value : e.title,
      subtitle: sub ? fields.find((f) => f.key === sub)!.value : e.subtitle,
    };
  });
}

export function modelSetText(m: CvModel, section: string, index: number, text: string): CvModel {
  return mapEntry(m, section, index, (e) => ({ ...e, text }));
}

export function modelSetBullet(m: CvModel, section: string, index: number, bulletIdx: number, text: string): CvModel {
  return mapEntry(m, section, index, (e) => ({
    ...e,
    bullets: (e.bullets ?? []).map((b, i) => (i === bulletIdx ? { ...b, text } : b)),
  }));
}

export function modelInsertBullet(
  m: CvModel,
  section: string,
  index: number,
  at: number,
  bullet: Bullet,
): CvModel {
  return mapEntry(m, section, index, (e) => {
    const bullets = [...(e.bullets ?? [])];
    bullets.splice(at, 0, bullet);
    return { ...e, bullets };
  });
}

export function modelRemoveBullet(m: CvModel, section: string, index: number, at: number): CvModel {
  return mapEntry(m, section, index, (e) => {
    const bullets = [...(e.bullets ?? [])];
    bullets.splice(at, 1);
    return { ...e, bullets };
  });
}

export function modelMoveBullet(m: CvModel, section: string, index: number, from: number, to: number): CvModel {
  return mapEntry(m, section, index, (e) => {
    const bullets = [...(e.bullets ?? [])];
    const [b] = bullets.splice(from, 1);
    bullets.splice(to, 0, b);
    return { ...e, bullets };
  });
}

/** Ops helper: append, coalescing consecutive `set`s on the same path (per-keystroke edits → one op). */
export function appendOp(ops: Op[], op: Op): Op[] {
  const last = ops[ops.length - 1];
  if (
    last &&
    last.op === "set" &&
    op.op === "set" &&
    last.path.length === op.path.length &&
    last.path.every((s, i) => s === op.path[i])
  ) {
    return [...ops.slice(0, -1), op];
  }
  return [...ops, op];
}
