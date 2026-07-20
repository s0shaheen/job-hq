"use client";

import { useEffect, useRef, useState } from "react";
import type { QueueItem } from "@/lib/types";

/**
 * Keyboard-first queue. j/k move the selection; Enter or o opens the selected
 * posting; i / x / s are the Phase-2 triage keys — for now they only toast
 * (v1 is read-only, no API calls).
 */

const READONLY_TOAST = "writes arrive in Phase 2 stage 3";
const TOAST_MS = 2200;

function isRemote(item: QueueItem): boolean {
  const r = item.postings.geo?.remote;
  return r === true || r === "true" || r === "yes" || r === "remote";
}

function minYoe(item: QueueItem): string | null {
  const v = item.postings.tags?.min_yoe;
  if (v === null || v === undefined || v === "") return null;
  return `${v}+ yrs`;
}

function compRange(item: QueueItem): string | null {
  const v = item.postings.tags?.comp_range;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function whyLine(item: QueueItem): string {
  const reason = item.disposition_reason?.trim();
  return reason && reason !== "" ? reason : "fits your profile";
}

export default function QueueList({ items }: { items: QueueItem[] }) {
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ msg, id });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // Enter on a focused link/button belongs to that element, not to the
      // queue — otherwise Enter both activates it and opens the selected card.
      if (e.key === "Enter" && target && /^(A|BUTTON)$/.test(target.tagName)) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setSelected((s) => Math.min(s + 1, items.length - 1));
          break;
        case "k":
          e.preventDefault();
          setSelected((s) => Math.max(s - 1, 0));
          break;
        case "o":
        case "Enter": {
          const item = items[selected];
          if (item?.postings.url) {
            e.preventDefault();
            window.open(item.postings.url, "_blank", "noopener,noreferrer");
          }
          break;
        }
        case "i":
        case "x":
        case "s":
          e.preventDefault();
          showToast(READONLY_TOAST);
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, selected]);

  // Keep the selected card in view as j/k moves it.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  return (
    <>
      <div className="kbd-hints" aria-hidden="true">
        <span>
          <kbd>j</kbd>/<kbd>k</kbd> move
        </span>
        <span>
          <kbd>o</kbd> open
        </span>
        <span>
          <kbd>i</kbd> interested
        </span>
        <span>
          <kbd>x</kbd> pass
        </span>
        <span>
          <kbd>s</kbd> snooze
        </span>
      </div>

      <ul className="queue-list" ref={listRef}>
        {items.map((item, idx) => {
          const p = item.postings;
          const yoe = minYoe(item);
          const comp = compRange(item);
          return (
            <li
              key={item.posting_key}
              className={idx === selected ? "card selected" : "card"}
              onClick={() => setSelected(idx)}
              aria-current={idx === selected ? "true" : undefined}
            >
              <div className="card-top">
                <span className="card-company">{p.company}</span>
                <span className="card-title">{p.title}</span>
                {p.location ? <span className="card-loc">{p.location}</span> : null}
              </div>
              <div className="chips">
                {p.geo?.market ? (
                  <span className="chip chip-market">{p.geo.market}</span>
                ) : null}
                {isRemote(item) ? <span className="chip chip-remote">Remote</span> : null}
                {yoe ? <span className="chip">{yoe}</span> : null}
                {comp ? <span className="chip">{comp}</span> : null}
              </div>
              <div className="card-why">{whyLine(item)}</div>
              <a
                className="card-link"
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                View posting
              </a>
            </li>
          );
        })}
      </ul>

      {toast ? (
        <div key={toast.id} className="toast" role="status">
          {toast.msg}
        </div>
      ) : null}
    </>
  );
}
