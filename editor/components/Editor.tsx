"use client";

// The whole editor. Per-file state machine:
//   clean --content edit--> ops   (op log replayed server-side at publish)
//   clean --raw edit------> raw   (full text committed after parse check)
//   ops   --raw edit------> raw   (pending ops folded into the text first)
//   raw   --content edit--> raw   (op applied to the text client-side, same
//                                  comment-preserving Document round-trip)
// Publish = one commit per dirty file, then poll the render workflow for the
// last commit sha. Optimistic UI: the model updates instantly; GitHub is the
// source of truth and a sha mismatch aborts with a reload prompt.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ContentView, { type ContentActions } from "./ContentView";
import RawEditor from "./RawEditor";
import PublishModal, { type PublishFile } from "./PublishModal";
import { estimatePage } from "../lib/estimate";
import { applyOps, yamlError, type Op } from "../lib/yamlops";
import {
  buildModel,
  entryPath,
  highlightsPath,
  appendOp,
  modelSetField,
  modelSetText,
  modelSetBullet,
  modelInsertBullet,
  modelRemoveBullet,
  modelMoveBullet,
  type CvModel,
  type EntryModel,
} from "../lib/model";

type Which = "base" | "design";
type Tab = "content" | "design" | "raw";

type FileCore = {
  status: "loading" | "ready" | "error";
  loadError: string | null;
  path: string;
  sha: string;
  originalText: string;
  mode: "clean" | "ops" | "raw";
  ops: Op[];
  rawText: string; // canonical when mode==="raw"; mirrors originalText when clean
};

const EMPTY: FileCore = {
  status: "loading",
  loadError: null,
  path: "",
  sha: "",
  originalText: "",
  mode: "clean",
  ops: [],
  rawText: "",
};

type RunResp = {
  found: boolean;
  runCount: number;
  status?: string;
  conclusion?: string | null;
  htmlUrl?: string;
  workflowName?: string;
};

export default function Editor({
  repo,
  branch,
  publishLinkUrl,
  publishLinkLabel,
}: {
  repo: string;
  branch: string;
  // WHERE a deployment's render workflow puts the finished PDF — Drive, S3, an
  // artifact page, nowhere at all — is that deployment's business, not this
  // component's. Both halves are configuration for the same reason: a label
  // hardcoded to "Drive" is a lie on every install that does not use Drive, and
  // this editor is no longer a single owner's tool.
  publishLinkUrl: string | null;
  publishLinkLabel: string;
}) {
  const [tab, setTab] = useState<Tab>("content");
  const [base, setBase] = useState<FileCore>(EMPTY);
  const [design, setDesign] = useState<FileCore>(EMPTY);
  const [model, setModel] = useState<CvModel | null>(null);
  const [baseParseError, setBaseParseError] = useState<string | null>(null);
  const [baseModelError, setBaseModelError] = useState<string | null>(null);
  const [designParseError, setDesignParseError] = useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<number | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<{ message: string; stale: boolean } | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);

  const [poll, setPoll] = useState<{ sha: string; startedAt: number } | null>(null);
  const [run, setRun] = useState<RunResp | null>(null);
  const [pollNote, setPollNote] = useState<string | null>(null);

  const nextIdRef = useRef(1);

  const rebuildModel = useCallback((text: string) => {
    const err = yamlError(text);
    setBaseParseError(err);
    setAutoFocusId(null);
    if (err) return; // keep the last good model on screen; content editing is blocked anyway
    try {
      setModel(buildModel(text, () => nextIdRef.current++));
      setBaseModelError(null);
    } catch (e) {
      setBaseModelError((e as Error).message);
    }
  }, []);

  const loadFile = useCallback(
    async (which: Which) => {
      const setter = which === "base" ? setBase : setDesign;
      setter((p) => ({ ...p, status: "loading", loadError: null }));
      try {
        const res = await fetch(`/api/file?which=${which}`, { cache: "no-store" });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        const j = (await res.json()) as { path: string; content: string; sha: string; message?: string; error?: string };
        if (!res.ok) throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
        setter({
          status: "ready",
          loadError: null,
          path: j.path,
          sha: j.sha,
          originalText: j.content,
          mode: "clean",
          ops: [],
          rawText: j.content,
        });
        if (which === "base") rebuildModel(j.content);
        else setDesignParseError(null);
      } catch (e) {
        setter((p) => ({ ...p, status: "error", loadError: (e as Error).message }));
      }
    },
    [rebuildModel],
  );

  useEffect(() => {
    void loadFile("base");
    void loadFile("design");
  }, [loadFile]);

  // ---- dirty tracking ----
  const baseDirty = base.mode === "ops" ? base.ops.length > 0 : base.mode === "raw" && base.rawText !== base.originalText;
  const designDirty = design.mode === "raw" && design.rawText !== design.originalText;
  const anyDirty = baseDirty || designDirty;

  const dirtyRef = useRef(false);
  dirtyRef.current = anyDirty;
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ---- content edits: mirror to model + record op (or fold into raw text) ----
  function contentEdit(op: Op, apply: (m: CvModel) => CvModel) {
    if (base.status !== "ready") return;
    if (base.mode === "raw") {
      try {
        const nextRaw = applyOps(base.rawText, [op]);
        setBase({ ...base, rawText: nextRaw });
      } catch (e) {
        setBaseModelError(`edit failed (${(e as Error).message}) — use the Raw tab`);
        return;
      }
    } else {
      setBase({ ...base, mode: "ops", ops: appendOp(base.ops, op) });
    }
    setModel((m) => (m ? apply(m) : m));
  }

  const actions: ContentActions = {
    setField: (e, key, value) =>
      contentEdit({ op: "set", path: [...entryPath(e), key], value }, (m) =>
        modelSetField(m, e.section, e.index, key, value),
      ),
    setTextEntry: (e, value) =>
      contentEdit({ op: "set", path: entryPath(e), value }, (m) => modelSetText(m, e.section, e.index, value)),
    setBullet: (e, i, value) =>
      contentEdit({ op: "set", path: [...highlightsPath(e), i], value }, (m) =>
        modelSetBullet(m, e.section, e.index, i, value),
      ),
    addBullet: (e: EntryModel) => {
      const at = e.bullets?.length ?? 0;
      const id = nextIdRef.current++;
      contentEdit({ op: "insert", path: highlightsPath(e), index: at, value: "" }, (m) =>
        modelInsertBullet(m, e.section, e.index, at, { id, text: "" }),
      );
      setAutoFocusId(id);
    },
    removeBullet: (e, i) =>
      contentEdit({ op: "remove", path: highlightsPath(e), index: i }, (m) =>
        modelRemoveBullet(m, e.section, e.index, i),
      ),
    moveBullet: (e, from, to) =>
      contentEdit({ op: "move", path: highlightsPath(e), from, to }, (m) =>
        modelMoveBullet(m, e.section, e.index, from, to),
      ),
  };

  // ---- raw edits ----
  const baseRawDisplay = useMemo(() => {
    if (base.mode === "ops" && base.ops.length > 0) {
      try {
        return applyOps(base.originalText, base.ops);
      } catch {
        return base.originalText;
      }
    }
    return base.rawText;
  }, [base.mode, base.ops, base.originalText, base.rawText]);

  function baseRawEdit(text: string) {
    setBase((p) => ({ ...p, mode: "raw", ops: [], rawText: text }));
    rebuildModel(text);
  }

  function designRawEdit(text: string) {
    setDesign((p) => ({ ...p, mode: "raw", rawText: text }));
    setDesignParseError(yamlError(text));
  }

  // ---- discard / reload ----
  function discardAll() {
    setBase((p) => ({ ...p, mode: "clean", ops: [], rawText: p.originalText }));
    if (base.status === "ready") rebuildModel(base.originalText);
    setDesign((p) => ({ ...p, mode: "clean", rawText: p.originalText }));
    setDesignParseError(null);
    setDiscardArmed(false);
    setPublishError(null);
  }

  function reloadFromGitHub() {
    setModalOpen(false);
    setPublishError(null);
    void loadFile("base");
    void loadFile("design");
  }

  // ---- publish ----
  const publishBlocked = (baseDirty && baseParseError) || (designDirty && designParseError) ? true : false;

  async function publish(label: string) {
    setPublishBusy(true);
    setPublishError(null);
    try {
      const targets: Which[] = [];
      if (baseDirty) targets.push("base");
      if (designDirty) targets.push("design");
      let lastCommit: string | null = null;
      for (const which of targets) {
        const st = which === "base" ? base : design;
        const payload =
          st.mode === "ops"
            ? { which, sha: st.sha, label, structuredOps: st.ops }
            : { which, sha: st.sha, label, contentString: st.rawText };
        const res = await fetch("/api/file", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        const j = (await res.json().catch(() => ({}))) as {
          content?: string;
          fileSha?: string;
          commitSha?: string;
          message?: string;
          error?: string;
        };
        if (!res.ok || !j.content || !j.fileSha || !j.commitSha) {
          setPublishError({
            message: j.message ?? j.error ?? `HTTP ${res.status}`,
            stale: j.error === "stale",
          });
          return;
        }
        const synced: Partial<FileCore> = {
          sha: j.fileSha,
          originalText: j.content,
          rawText: j.content,
          mode: "clean",
          ops: [],
        };
        if (which === "base") {
          setBase((p) => ({ ...p, ...synced }));
          rebuildModel(j.content);
        } else {
          setDesign((p) => ({ ...p, ...synced }));
        }
        lastCommit = j.commitSha;
      }
      if (lastCommit) {
        setPoll({ sha: lastCommit, startedAt: Date.now() });
        setRun(null);
        setPollNote(null);
      }
      setModalOpen(false);
    } catch (e) {
      setPublishError({ message: `network error: ${(e as Error).message}`, stale: false });
    } finally {
      setPublishBusy(false);
    }
  }

  // ---- render-run polling (5s ticks, stop on completion or after 6 min) ----
  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch(`/api/run-status?sha=${poll!.sha}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const j = (await res.json()) as RunResp;
          if (cancelled) return;
          setRun(j);
          if (j.found && j.status === "completed") return; // terminal — stop polling
        }
      } catch {
        /* transient network hiccup — keep polling */
      }
      if (cancelled) return;
      if (Date.now() - poll!.startedAt > 6 * 60_000) {
        setPollNote("stopped watching after 6 min — check the run on GitHub");
        return;
      }
      timer = setTimeout(() => void tick(), 5000);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [poll]);

  // ---- derived UI bits ----
  const fit = useMemo(() => estimatePage(model), [model]);
  const blockedReason = baseParseError ? "the file has a YAML parse error — fix it in the Raw tab" : baseModelError;

  const publishFiles: PublishFile[] = [];
  if (baseDirty) {
    publishFiles.push({
      which: "base",
      path: base.path || "resume/base.yaml",
      summary: base.mode === "ops" ? `${base.ops.length} edit${base.ops.length === 1 ? "" : "s"}` : "raw edit",
    });
  }
  if (designDirty) {
    publishFiles.push({ which: "design", path: design.path || "resume/design.yaml", summary: "raw edit" });
  }

  function dismissRun() {
    setPoll(null);
    setRun(null);
    setPollNote(null);
  }

  function runChip() {
    if (!poll) return null;
    const link = run?.htmlUrl ? (
      <a href={run.htmlUrl} target="_blank" rel="noreferrer">
        view run
      </a>
    ) : null;
    let chip: React.ReactNode;
    if (!run) {
      chip = (
        <span className="chip busy">
          <span className="dot" />
          checking workflow…
        </span>
      );
    } else if (!run.found) {
      chip = (
        <span className="chip busy">
          <span className="dot" />
          waiting for workflow run…
        </span>
      );
    } else if (run.status !== "completed") {
      chip = (
        <span className="chip busy">
          <span className="dot" />
          {run.status === "queued" ? "render queued…" : "rendering…"}
        </span>
      );
    } else if (run.conclusion === "success") {
      chip = (
        <>
          <span className="chip ok">
            <span className="dot" />
            rendered
          </span>
          {publishLinkUrl ? (
            <a href={publishLinkUrl} target="_blank" rel="noreferrer">
              {publishLinkLabel}
            </a>
          ) : null}
        </>
      );
    } else {
      chip = (
        <span className="chip err">
          <span className="dot" />
          render {run.conclusion ?? "failed"}
        </span>
      );
    }
    return (
      <>
        {chip}
        {run?.status === "completed" && run.conclusion === "success" ? link : run ? link : null}
        {pollNote ? <span style={{ color: "var(--muted)" }}>{pollNote}</span> : null}
        <button type="button" className="icon-btn" aria-label="dismiss status" onClick={dismissRun}>
          ×
        </button>
      </>
    );
  }

  const tabs: Array<{ id: Tab; label: string; dirty: boolean }> = [
    { id: "content", label: "Content", dirty: baseDirty },
    { id: "design", label: "Design", dirty: designDirty },
    { id: "raw", label: "Raw", dirty: baseDirty },
  ];

  return (
    <div className="container">
      <header className="app-header">
        <h1>Resume Editor</h1>
        <span className="repo">
          {repo}@{branch}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="reload from GitHub"
          title="Reload from GitHub"
          onClick={() => {
            if (!anyDirty || window.confirm("Discard unpublished changes and reload from GitHub?")) {
              reloadFromGitHub();
            }
          }}
        >
          ↻
        </button>
      </header>

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.dirty ? <span className="dot" aria-label="unpublished changes" /> : null}
          </button>
        ))}
      </nav>

      {tab === "content" ? (
        <FilePane st={base} retry={() => void loadFile("base")}>
          <ContentView model={model} blockedReason={blockedReason} actions={actions} autoFocusId={autoFocusId} />
        </FilePane>
      ) : null}

      {tab === "design" ? (
        <FilePane st={design} retry={() => void loadFile("design")}>
          <RawEditor path={design.path} text={design.rawText} onChange={designRawEdit} error={designParseError} />
        </FilePane>
      ) : null}

      {tab === "raw" ? (
        <FilePane st={base} retry={() => void loadFile("base")}>
          <RawEditor
            path={base.path}
            text={baseRawDisplay}
            onChange={baseRawEdit}
            error={baseParseError}
            note={
              base.mode === "ops" && base.ops.length > 0
                ? "Showing your unpublished content edits folded into the file. Typing here switches to raw mode (same edits, committed as full text)."
                : null
            }
          />
        </FilePane>
      ) : null}

      <div className="bottom-bar">
        <div className="inner">
          <div className="bar-status">
            {fit ? (
              <span
                className={`chip ${fit.verdict === "fits" ? "ok" : fit.verdict === "tight" ? "warn" : "err"}`}
                title="Client-side estimate only — CI enforces the real one-page gate at render time."
              >
                <span className="dot" />
                {fit.label} · {fit.lines}/{fit.budget}
              </span>
            ) : null}
            {publishBusy ? (
              <span className="chip busy">
                <span className="dot" />
                publishing…
              </span>
            ) : (
              runChip()
            )}
          </div>
          <div className="bar-actions">
            <span className="dirty-note">
              {publishBlocked
                ? "fix the YAML error before publishing"
                : anyDirty
                  ? `unpublished: ${publishFiles.map((f) => f.path.split("/").pop()).join(" · ")}`
                  : "everything published"}
            </span>
            <span className="spacer" />
            {anyDirty ? (
              <button
                type="button"
                className={discardArmed ? "btn small danger" : "btn small ghost"}
                onClick={() => (discardArmed ? discardAll() : setDiscardArmed(true))}
                onBlur={() => setDiscardArmed(false)}
              >
                {discardArmed ? "sure?" : "Discard"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn primary"
              disabled={!anyDirty || publishBusy || publishBlocked}
              onClick={() => {
                setPublishError(null);
                setModalOpen(true);
              }}
            >
              Publish
            </button>
          </div>
        </div>
      </div>

      {modalOpen ? (
        <PublishModal
          files={publishFiles}
          fit={fit}
          busy={publishBusy}
          error={publishError?.message ?? null}
          stale={publishError?.stale ?? false}
          onClose={() => setModalOpen(false)}
          onPublish={(label) => void publish(label)}
          onReload={reloadFromGitHub}
        />
      ) : null}
    </div>
  );
}

function FilePane({
  st,
  retry,
  children,
}: {
  st: FileCore;
  retry: () => void;
  children: React.ReactNode;
}) {
  if (st.status === "loading") return <div className="loading">loading {st.path || "file"}…</div>;
  if (st.status === "error") {
    return (
      <div className="banner err">
        failed to load: {st.loadError}
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn small" onClick={retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
