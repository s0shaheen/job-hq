// Structured edits applied through the eemeli `yaml` Document API so comments,
// blank lines, anchors and quoting style survive — the whole point: a phone
// edit must diff as ONLY the touched nodes, never a reserialized file.
// Isomorphic on purpose: the server replays ops authoritatively at publish
// time; the client uses the same function to materialize the RAW-tab preview.

import { parseDocument, isScalar, isSeq, type YAMLSeq } from "yaml";

export type PathSeg = string | number;

export type Op =
  | { op: "set"; path: PathSeg[]; value: string | number | boolean | null }
  | { op: "insert"; path: PathSeg[]; index: number; value: string }
  | { op: "remove"; path: PathSeg[]; index: number }
  | { op: "move"; path: PathSeg[]; from: number; to: number };

// lineWidth: 0 disables folding — long one-line bullets must never re-wrap
// (diff noise, and the repo's bullets are deliberately single-line).
const STR_OPTS = { lineWidth: 0 } as const;

/** Parse-validate a raw YAML string. Returns null when valid, else the parser's message. */
export function yamlError(source: string): string | null {
  const doc = parseDocument(source);
  return doc.errors.length ? doc.errors[0].message : null;
}

/**
 * Replay `ops` against `source` and return the new YAML text.
 * Throws with an op-indexed message on any structural mismatch — the caller
 * treats that as client/server divergence (fail loud, nothing written).
 */
export function applyOps(source: string, ops: Op[]): string {
  const doc = parseDocument(source);
  if (doc.errors.length) {
    throw new Error(`source YAML failed to parse: ${doc.errors[0].message}`);
  }
  ops.forEach((op, i) => {
    try {
      applyOne(doc, op);
    } catch (e) {
      throw new Error(`op ${i} (${op.op} @ ${op.path.join(".")}): ${(e as Error).message}`);
    }
  });
  return doc.toString(STR_OPTS);
}

function applyOne(doc: ReturnType<typeof parseDocument>, op: Op): void {
  switch (op.op) {
    case "set": {
      const node = doc.getIn(op.path, true);
      if (isScalar(node)) {
        // Mutating .value keeps the node identity: comments, anchor, and
        // quoting style stay attached (stringifier re-quotes only if the new
        // value can't be represented in the old style).
        node.value = op.value;
      } else {
        doc.setIn(op.path, op.value);
      }
      return;
    }
    case "insert": {
      const seq = getSeq(doc, op.path);
      if (op.index < 0 || op.index > seq.items.length) throw new Error(`insert index ${op.index} out of range`);
      seq.items.splice(op.index, 0, doc.createNode(op.value));
      return;
    }
    case "remove": {
      const seq = getSeq(doc, op.path);
      assertIndex(seq, op.index);
      seq.items.splice(op.index, 1);
      return;
    }
    case "move": {
      const seq = getSeq(doc, op.path);
      assertIndex(seq, op.from);
      if (op.to < 0 || op.to >= seq.items.length) throw new Error(`move target ${op.to} out of range`);
      const [item] = seq.items.splice(op.from, 1);
      seq.items.splice(op.to, 0, item); // node moves whole — its comments travel with it
      return;
    }
  }
}

function getSeq(doc: ReturnType<typeof parseDocument>, path: PathSeg[]): YAMLSeq {
  const node = doc.getIn(path);
  if (!isSeq(node)) throw new Error("path is not a sequence");
  return node;
}

function assertIndex(seq: YAMLSeq, i: number): void {
  if (i < 0 || i >= seq.items.length) throw new Error(`index ${i} out of range (len ${seq.items.length})`);
}

/** Runtime shape-check for ops arriving over the wire. Returns an error string or null. */
export function invalidOps(x: unknown): string | null {
  if (!Array.isArray(x)) return "structuredOps must be an array";
  if (x.length === 0) return "structuredOps is empty";
  if (x.length > 500) return "too many ops";
  for (let i = 0; i < x.length; i++) {
    const o = x[i] as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return `op ${i}: not an object`;
    if (!Array.isArray(o.path) || o.path.length === 0) return `op ${i}: bad path`;
    if (!o.path.every((s: unknown) => typeof s === "string" || (typeof s === "number" && Number.isInteger(s)))) {
      return `op ${i}: path segments must be strings or integers`;
    }
    switch (o.op) {
      case "set":
        if (!["string", "number", "boolean"].includes(typeof o.value) && o.value !== null) return `op ${i}: bad value`;
        break;
      case "insert":
        if (!Number.isInteger(o.index) || typeof o.value !== "string") return `op ${i}: bad insert`;
        break;
      case "remove":
        if (!Number.isInteger(o.index)) return `op ${i}: bad remove`;
        break;
      case "move":
        if (!Number.isInteger(o.from) || !Number.isInteger(o.to)) return `op ${i}: bad move`;
        break;
      default:
        return `op ${i}: unknown op "${String(o.op)}"`;
    }
  }
  return null;
}
