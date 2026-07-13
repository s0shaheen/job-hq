"use client";

import { useState } from "react";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!passcode || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (res.ok) {
        window.location.replace("/");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `login failed (${res.status})`);
    } catch {
      setError("network error — try again");
    }
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Resume Editor</h1>
        <p className="login-err">{error}</p>
        <input
          type="password"
          inputMode="text"
          autoComplete="current-password"
          placeholder="passcode"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={busy || !passcode}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
