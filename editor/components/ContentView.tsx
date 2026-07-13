"use client";

// Sections -> entry cards -> draggable bullet rows. Bullets reorder only
// within their own entry (one DndContext per entry), matching the resume
// rule that tailoring reorders bullets inside a role.

import { useEffect, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import GrowTextarea from "./GrowTextarea";
import type { Bullet, CvModel, EntryModel } from "../lib/model";

export type ContentActions = {
  setField: (e: EntryModel, key: string, value: string) => void;
  setTextEntry: (e: EntryModel, value: string) => void;
  setBullet: (e: EntryModel, index: number, value: string) => void;
  addBullet: (e: EntryModel) => void;
  removeBullet: (e: EntryModel, index: number) => void;
  moveBullet: (e: EntryModel, from: number, to: number) => void;
};

const WIDE_FIELDS = new Set(["details", "summary", "highlights"]);

export default function ContentView({
  model,
  blockedReason,
  actions,
  autoFocusId,
}: {
  model: CvModel | null;
  blockedReason: string | null;
  actions: ContentActions;
  autoFocusId: number | null;
}) {
  if (blockedReason) {
    return <div className="banner err">Content editing unavailable: {blockedReason}</div>;
  }
  if (!model) return <div className="loading">no content model</div>;
  return (
    <div>
      {model.sections.map((sec) => (
        <section key={sec.name}>
          <h2 className="section-title">{sec.display}</h2>
          {sec.entries.map((entry) => (
            <EntryCard
              key={`${sec.name}:${entry.index}`}
              entry={entry}
              actions={actions}
              autoFocusId={autoFocusId}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function metaLine(entry: EntryModel): string {
  const get = (k: string) => entry.fields.find((f) => f.key === k)?.value?.trim() ?? "";
  const dates =
    get("start_date") || get("end_date")
      ? [get("start_date"), get("end_date")].filter(Boolean).join(" – ")
      : get("date");
  return [dates, get("location")].filter(Boolean).join(" · ");
}

function EntryCard({
  entry,
  actions,
  autoFocusId,
}: {
  entry: EntryModel;
  actions: ContentActions;
  autoFocusId: number | null;
}) {
  // Bullet-less entries (skills, education) show their fields directly —
  // the fields ARE the content. Experience keeps fields tucked away.
  const [open, setOpen] = useState(entry.bullets === null);

  if (entry.kind === "text") {
    return (
      <div className="entry-card">
        <GrowTextarea value={entry.text} onChange={(v) => actions.setTextEntry(entry, v)} />
      </div>
    );
  }

  return (
    <div className="entry-card">
      <button type="button" className="entry-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="titles">
          <span className="entry-title" style={{ display: "block" }}>
            {entry.title || "(untitled)"}
          </span>
          {entry.subtitle ? (
            <span className="entry-subtitle" style={{ display: "block" }}>
              {entry.subtitle}
            </span>
          ) : null}
          {metaLine(entry) ? (
            <span className="entry-meta" style={{ display: "block" }}>
              {metaLine(entry)}
            </span>
          ) : null}
        </span>
        <span className={open ? "chev open" : "chev"} aria-hidden>
          ▶
        </span>
      </button>
      {open ? (
        <div className="fields">
          {entry.fields.map((f) => (
            <div key={f.key} className={WIDE_FIELDS.has(f.key) || f.value.length > 40 ? "field wide" : "field"}>
              <label htmlFor={`f-${entry.section}-${entry.index}-${f.key}`}>{f.key.replace(/_/g, " ")}</label>
              {WIDE_FIELDS.has(f.key) || f.value.length > 60 ? (
                <GrowTextarea value={f.value} onChange={(v) => actions.setField(entry, f.key, v)} />
              ) : (
                <input
                  id={`f-${entry.section}-${entry.index}-${f.key}`}
                  type="text"
                  value={f.value}
                  onChange={(e) => actions.setField(entry, f.key, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      ) : null}
      {entry.bullets ? <BulletList entry={entry} actions={actions} autoFocusId={autoFocusId} /> : null}
    </div>
  );
}

function BulletList({
  entry,
  actions,
  autoFocusId,
}: {
  entry: EntryModel;
  actions: ContentActions;
  autoFocusId: number | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const bullets = entry.bullets ?? [];
  const ids = bullets.map((b) => b.id);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id as number);
    const to = ids.indexOf(over.id as number);
    if (from < 0 || to < 0 || from === to) return;
    actions.moveBullet(entry, from, to);
  }

  return (
    <div className="bullets">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {bullets.map((b, i) => (
            <BulletRow
              key={b.id}
              bullet={b}
              autoFocus={b.id === autoFocusId}
              onChange={(v) => actions.setBullet(entry, i, v)}
              onRemove={() => actions.removeBullet(entry, i)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button type="button" className="add-bullet" onClick={() => actions.addBullet(entry)}>
        + bullet
      </button>
    </div>
  );
}

function BulletRow({
  bullet,
  autoFocus,
  onChange,
  onRemove,
}: {
  bullet: Bullet;
  autoFocus: boolean;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bullet.id });
  const [armed, setArmed] = useState(false);

  // two-tap delete: first tap arms for 2.5s, second tap actually deletes
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "bullet-row dragging" : "bullet-row"}>
      <button type="button" className="drag-handle" aria-label="drag to reorder" {...attributes} {...listeners}>
        ≡
      </button>
      <GrowTextarea value={bullet.text} onChange={onChange} autoFocus={autoFocus} placeholder="new bullet…" />
      <button
        type="button"
        className={armed ? "bullet-x armed" : "bullet-x"}
        aria-label={armed ? "tap again to delete" : "delete bullet"}
        onClick={() => (armed ? onRemove() : setArmed(true))}
      >
        {armed ? "sure?" : "×"}
      </button>
    </div>
  );
}
