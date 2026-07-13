"use client";

import { useState } from "react";
import type { Fit } from "../lib/estimate";

export type PublishFile = { which: "base" | "design"; path: string; summary: string };

export default function PublishModal({
  files,
  fit,
  busy,
  error,
  stale,
  onClose,
  onPublish,
  onReload,
}: {
  files: PublishFile[];
  fit: Fit | null;
  busy: boolean;
  error: string | null;
  stale: boolean;
  onClose: () => void;
  onPublish: (label: string) => void;
  onReload: () => void;
}) {
  const [label, setLabel] = useState("");

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Publish to GitHub</h2>
        <ul className="files">
          {files.map((f) => (
            <li key={f.which}>
              <span>{f.path}</span>
              <span className="n">{f.summary}</span>
            </li>
          ))}
        </ul>
        {fit && fit.verdict !== "fits" ? (
          <div className={fit.verdict === "tight" ? "banner warn" : "banner err"}>
            Page estimate: {fit.label} ({fit.lines}/{fit.budget} line units). CI enforces the real one-page gate —
            the render fails loudly if it overflows.
          </div>
        ) : null}
        <input
          type="text"
          placeholder="version label (optional)"
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
        />
        <p className="hint">
          Commits as “resume: {label.trim() || "phone edit"}”
          {files.length > 1 ? ` — ${files.length} commits, one per file` : ""}. The render workflow fires on push;
          the PDF lands in Drive &gt; Resume &gt; Current.
        </p>
        {error ? (
          <div className="banner err">
            {error}
            {stale ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn small danger" onClick={onReload}>
                  Discard my edits &amp; reload from GitHub
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onPublish(label)} disabled={busy}>
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}
