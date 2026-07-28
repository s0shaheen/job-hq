"use client";

/**
 * PROVISIONAL implementation of the owner's "Find intro" design (layer 2 — the
 * on-demand warm-referral finder). This is a real, wired cell — it starts vendor
 * searches, polls them, pins people — but its LOOK is a hand-built stand-in for
 * the design-system version to come. Swap this file for that one later; the prop
 * contract (`WarmIntroCellProps`) and the `data-testid`s the E2E gates on are the
 * stable surface, the markup is not.
 *
 * WHY THIS MAY FETCH AND `warm-cell.tsx` MAY NOT. `lib/referral/` + `warm-cell`
 * are layer 0: every LinkedIn URL there is an `<a href>` the reader clicks in
 * their own session, and `referral-hard-line.test.ts` forbids `fetch` across that
 * whole surface because one request added there is the account-ending category.
 * This cell is the opposite lane — it talks to `/api/warm/*` (same-origin), which
 * is where the app's own vendor call lives, behind `server-only`. It lives in
 * `components/` and is NOT named `warm-cell`, so it sits outside that sweep by
 * construction.
 *
 * The lifecycle is the routes' (`lib/warm/handler.ts`): POST /api/warm/start,
 * then poll GET /api/warm/{id} until terminal, with POST /api/warm/{id}/cancel
 * the escape hatch. Pin / add / unpin are the server actions in
 * `lib/warm/actions.ts` — never a fetch, because a pin is an app write, not a
 * vendor call.
 *
 * PINS ARE A SET. The results panel multi-selects, and "Pin selected" pins every
 * checked candidate (one action call each), so a row carries an ARRAY of pins.
 * `pins` seeds from the prop and updates locally the instant each action returns.
 * The results panel also shows each candidate's LLM FIT reason (transparent — the
 * reason string, never a bare tier) beside the deterministic signal chips.
 *
 * PROVISIONAL: ahead of the owner's single-pin / 10-result design, built with the
 * existing primitives. Testids are the stable surface; the markup is not.
 */

import { Loader2, User, X } from "lucide-react";
import { Popover } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button, buttonClass } from "@/components/ui/button";
import type { WarmPinView, WarmSearchView, WarmTargetKind } from "@/lib/data/source";
import {
  addWarmIntroAction,
  pinWarmIntroAction,
  unpinWarmIntroAction,
} from "@/lib/warm/actions";
import {
  candidateKey,
  searchedForLine,
  type WarmCandidate,
  type WarmParams,
} from "@/lib/warm/types";
import { cn } from "@/lib/utils";

/** The search as the browser receives it — the routes strip `runIds` before answering. */
type WarmSearchClient = Omit<WarmSearchView, "runIds">;

export type WarmIntroCellProps = {
  /** Always "posting" from the grids; the type keeps the door open for company rows. */
  targetKind: WarmTargetKind;
  /** The row's posting key, or "" when the row has none (a manual application). */
  postingKey: string;
  /** The company, verbatim — what the copy names and the search runs on. */
  company: string;
  /** The posting/application title. Carried for parity with layer 0; not searched on. */
  title: string;
  /** The three persona strings a fresh confirm starts from (from the profile). */
  defaultParams: WarmParams;
  /**
   * The people already pinned for this row — a SET, since the finder's multi-select
   * pins every checked candidate. Reflected immediately after a pin/unpin gesture.
   */
  pins: WarmPinView[];
};

/** Merge freshly-pinned rows into the local set: same-id replaces, order by id. */
function mergePins(prev: WarmPinView[], added: WarmPinView[]): WarmPinView[] {
  const byId = new Map<number, WarmPinView>();
  for (const p of prev) byId.set(p.id, p);
  for (const p of added) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The confirm/running/results state machine. Idle when the popover is shut or reset. */
type Phase =
  | { kind: "confirm" }
  | { kind: "running"; id: string }
  | { kind: "results"; search: WarmSearchClient }
  | { kind: "empty"; search: WarmSearchClient }
  | { kind: "failed"; error: string }
  | { kind: "over-cap"; message: string };

const POLL_MS = 800;

export function WarmIntroCell(props: WarmIntroCellProps) {
  const { targetKind, postingKey, company, defaultParams } = props;

  // Local pin state seeded from the prop, so a pin reflects the instant its
  // server action returns rather than waiting on the revalidate the action also
  // fires. A reload reseeds from the prop, which is the reload-proof assertion.
  const [pins, setPins] = React.useState<WarmPinView[]>(props.pins);

  const [open, setOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>({ kind: "confirm" });

  // The editable persona strings for THIS search — reset to the defaults each
  // time the popover opens fresh. "Changes apply to this search only."
  const [params, setParams] = React.useState<WarmParams>(defaultParams);
  const [editing, setEditing] = React.useState(false);

  // One idempotency key per gesture, reset on success (warm-cell's PasteIdForm
  // rule): a fresh uuid per retry is what double-applies an append-only write.
  // Multi-select pins one candidate at a time, so the key is PER candidate (keyed
  // by `candidateKey`) — a retry after a partial failure reuses each survivor's
  // key rather than minting a new one that would double-pin.
  const pinIdems = React.useRef(new Map<string, string>());
  const addIdem = React.useRef<string | null>(null);

  // ---- polling ------------------------------------------------------------
  // Runs only while the phase is `running`; the cleanup stops it the moment the
  // phase leaves running (terminal, cancel, or unmount), and `stopped` guards a
  // fetch already in flight from writing state after that.
  React.useEffect(() => {
    if (phase.kind !== "running") return;
    const id = phase.id;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/warm/${id}`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const data = (await res.json()) as WarmSearchClient;
        if (stopped) return;
        if (data.status === "done") {
          setPhase(
            data.results.length > 0
              ? { kind: "results", search: data }
              : { kind: "empty", search: data },
          );
        } else if (data.status === "failed") {
          setPhase({ kind: "failed", error: data.error || "That search didn't complete." });
        } else if (data.status === "cancelled") {
          resetToIdle();
        }
        // 'running' → keep polling.
      } catch {
        /* a transient poll error retries on the next tick */
      }
    };
    void tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function resetToIdle() {
    setOpen(false);
    setPhase({ kind: "confirm" });
    setParams(defaultParams);
    setEditing(false);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Open fresh: back to the confirm form with the defaults. A search left
      // half-run when the popover closed does not re-appear.
      setPhase({ kind: "confirm" });
      setParams(defaultParams);
      setEditing(false);
    }
  }

  // ---- start / cancel -----------------------------------------------------
  async function onSearch() {
    const idempotencyKey = crypto.randomUUID();
    let res: Response;
    try {
      res = await fetch("/api/warm/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `overlays` filters the search on the user's warm background (schools /
        // past employers). Empty for now — a future Settings surface will fill
        // these from the profile; the route accepts `{schools:[], pastCompanies:[]}`
        // and the fit pass reasons over whatever is present.
        body: JSON.stringify({
          targetKind,
          postingKey,
          company,
          params,
          overlays: { schools: [], pastCompanies: [] },
          idempotencyKey,
        }),
      });
    } catch {
      setPhase({ kind: "failed", error: "That search didn't complete." });
      return;
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPhase({ kind: "over-cap", message: body.error || "You have used your warm searches for today." });
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPhase({ kind: "failed", error: body.error || "That search didn't complete." });
      return;
    }
    const search = (await res.json()) as WarmSearchClient;
    if (search.status === "failed") {
      setPhase({ kind: "failed", error: search.error || "That search didn't complete." });
    } else if (search.status === "done") {
      setPhase(
        search.results.length > 0
          ? { kind: "results", search }
          : { kind: "empty", search },
      );
    } else {
      setPhase({ kind: "running", id: search.id });
    }
  }

  async function onCancel() {
    if (phase.kind !== "running") return;
    const id = phase.id;
    resetToIdle(); // stops polling synchronously and returns the row to idle
    try {
      await fetch(`/api/warm/${id}/cancel`, { method: "POST" });
    } catch {
      /* best-effort; the row is already idle to the user */
    }
  }

  // ---- pin / add / unpin --------------------------------------------------
  // Pin every checked candidate — one action call each, a distinct idempotency
  // key per candidate. Stops at the first failure (and keeps the ones that landed
  // in local state). Returns whether the whole batch pinned, so the panel clears
  // its selection only on a clean run.
  async function onPinSelected(selected: WarmCandidate[]): Promise<boolean> {
    const pinned: WarmPinView[] = [];
    for (const c of selected) {
      const k = candidateKey(c);
      const idem = pinIdems.current.get(k) ?? crypto.randomUUID();
      pinIdems.current.set(k, idem);
      const result = await pinWarmIntroAction({
        targetKind,
        postingKey,
        company,
        fullName: c.fullName,
        profileUrl: c.linkedinUrl,
        headline: c.headline,
        idempotencyKey: idem,
      });
      if (result.ok) {
        pinIdems.current.delete(k);
        pinned.push(result.pin);
      } else {
        if (pinned.length > 0) setPins((prev) => mergePins(prev, pinned));
        toast.error(
          result.kind === "auth"
            ? "Your session expired — sign in again."
            : result.message || "That didn't work.",
        );
        return false;
      }
    }
    if (pinned.length === 0) return false;
    setPins((prev) => mergePins(prev, pinned));
    setOpen(false);
    toast.success(
      pinned.length === 1
        ? `Pinned ${pinned[0].fullName} at ${company}`
        : `Pinned ${pinned.length} intros at ${company}`,
    );
    return true;
  }

  async function onAdd(text: string): Promise<{ ok: boolean; error?: string }> {
    addIdem.current ??= crypto.randomUUID();
    const result = await addWarmIntroAction({
      targetKind,
      postingKey,
      company,
      text,
      idempotencyKey: addIdem.current,
    });
    if (result.ok) {
      addIdem.current = null;
      setPins((prev) => mergePins(prev, [result.pin]));
      setOpen(false);
      toast.success(`Pinned ${result.pin.fullName} at ${company}`);
      return { ok: true };
    }
    // A validation refusal (a non-LinkedIn URL) keeps the same key — the store
    // never saw it, so a corrected resubmit is the first real use of the key.
    return {
      ok: false,
      error:
        result.kind === "auth"
          ? "Your session expired — sign in again."
          : result.message || "That didn't work.",
    };
  }

  async function onUnpin(target: WarmPinView) {
    const idempotencyKey = crypto.randomUUID();
    const previous = pins;
    setPins((prev) => prev.filter((p) => p.id !== target.id)); // immediate
    const result = await unpinWarmIntroAction({ id: target.id, idempotencyKey });
    if (!result.ok) {
      setPins(previous);
      toast.error(
        result.kind === "auth"
          ? "Your session expired — sign in again."
          : result.message || "Could not remove the pin.",
      );
    }
  }

  // ---- the pinned cell ----------------------------------------------------
  // Once a row has pins the cell is the people, not a search button. A set now:
  // a count + names summary, each name with its own unpin control.
  if (pins.length > 0) {
    const names = pins.map((p) => p.fullName);
    const summary =
      pins.length > 1 ? `${pins.length} intros: ${names.join(", ")}` : names[0];
    return (
      <div
        data-testid="warm-intro-cell"
        className="flex min-w-0 max-w-full items-start gap-1"
      >
        <User aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ok" />
        <div
          data-testid="warm-intro-pinned"
          title={summary}
          className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5"
        >
          {pins.length > 1 ? (
            <span className="shrink-0 text-2xs text-muted">{pins.length} intros:</span>
          ) : null}
          {pins.map((p) => (
            <span
              key={p.id}
              className="inline-flex min-w-0 max-w-full items-center gap-0.5"
            >
              <PinnedName pin={p} />
              <button
                type="button"
                data-testid="warm-intro-unpin"
                onClick={() => onUnpin(p)}
                title="Remove intro"
                aria-label={`Remove ${p.fullName} as an intro for ${company}`}
                className="shrink-0 rounded p-0.5 text-muted hover:text-text-2
                           focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  }

  // ---- the search flow ----------------------------------------------------
  return (
    <div data-testid="warm-intro-cell" className="min-w-0 max-w-full">
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>
          {/* A raw <button>, not <Button>: Radix `asChild` sets a ref and the
              shared Button is not forwardRef (the same reason warm-cell.tsx
              triggers on a raw element). It wears the Button's classes so the
              two warm cells match. */}
          <button
            type="button"
            data-testid="warm-intro-find"
            className={cn(buttonClass({ variant: "secondary", size: "sm" }), "max-w-full")}
          >
            <span className="truncate">Find intro</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-40 w-80 max-w-[calc(100vw-16px)] rounded-lg border border-border
                       bg-surface p-3 shadow-xl outline-none"
          >
            {phase.kind === "confirm" ? (
              <ConfirmPanel
                company={company}
                params={params}
                editing={editing}
                onEdit={() => setEditing(true)}
                onChange={setParams}
                onSearch={onSearch}
                onCancel={() => onOpenChange(false)}
              />
            ) : phase.kind === "running" ? (
              <RunningPanel company={company} onCancel={onCancel} />
            ) : phase.kind === "results" ? (
              <ResultsPanel
                company={company}
                search={phase.search}
                onClose={resetToIdle}
                onPinSelected={onPinSelected}
                onAdd={onAdd}
              />
            ) : phase.kind === "empty" ? (
              <EmptyPanel
                company={company}
                search={phase.search}
                onClose={resetToIdle}
                onAdd={onAdd}
              />
            ) : phase.kind === "over-cap" ? (
              <OverCapPanel message={phase.message} onClose={resetToIdle} />
            ) : (
              <FailedPanel
                error={phase.error}
                onRetry={() => {
                  setPhase({ kind: "confirm" });
                  setEditing(false);
                }}
                onClose={resetToIdle}
              />
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── the panels

function ConfirmPanel({
  company,
  params,
  editing,
  onEdit,
  onChange,
  onSearch,
  onCancel,
}: {
  company: string;
  params: WarmParams;
  editing: boolean;
  onEdit: () => void;
  onChange: (p: WarmParams) => void;
  onSearch: () => void;
  onCancel: () => void;
}) {
  const rows: { key: keyof WarmParams; label: string; testid: string }[] = [
    { key: "role", label: "In your role:", testid: "warm-intro-input-role" },
    { key: "senior", label: "Senior in your area:", testid: "warm-intro-input-senior" },
    { key: "recruiter", label: "Recruiter:", testid: "warm-intro-input-recruiter" },
  ];
  return (
    <div data-testid="warm-intro-confirm">
      <p className="text-xs font-medium text-text">Find an intro at {company}</p>

      <dl className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="min-w-0 text-xs">
            <dt className="text-text-2">{r.label}</dt>
            {editing ? (
              <input
                data-testid={r.testid}
                value={params[r.key]}
                onChange={(e) => onChange({ ...params, [r.key]: e.target.value })}
                autoComplete="off"
                className="mt-0.5 w-full min-w-0 rounded-md border border-border bg-raised px-2 py-1
                           text-xs text-text placeholder:text-muted focus-visible:outline-2
                           focus-visible:-outline-offset-1 focus-visible:outline-ring"
              />
            ) : (
              <dd className="text-text">{params[r.key]}</dd>
            )}
          </div>
        ))}
      </dl>

      {editing ? null : (
        <button
          type="button"
          data-testid="warm-intro-edit-toggle"
          onClick={onEdit}
          className="mt-2 text-2xs text-muted underline decoration-dotted underline-offset-2
                     hover:text-text-2 focus-visible:outline-2 focus-visible:-outline-offset-1
                     focus-visible:outline-ring"
        >
          Edit for this search
        </button>
      )}
      <p className="mt-1 text-2xs text-muted">Defaults live in Settings.</p>
      <p className="text-2xs text-muted">Changes apply to this search only.</p>

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid="warm-intro-search"
          onClick={onSearch}
        >
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="warm-intro-cancel-confirm"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RunningPanel({ company, onCancel }: { company: string; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <div
        data-testid="warm-intro-running"
        title={`Looking for people you may know at ${company}`}
        className="flex min-w-0 items-center gap-1.5 text-xs text-text-2"
      >
        <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />
        <span>Looking…</span>
      </div>
      <button
        type="button"
        data-testid="warm-intro-cancel"
        onClick={onCancel}
        title="Cancel search"
        aria-label="Cancel search"
        className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-text-2
                   focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/** The shared header row for the results/empty panels — name, count, close. */
function PanelHeader({
  company,
  count,
  onClose,
}: {
  company: string;
  count: number | null;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-text">People you may know at {company}</p>
        {count !== null ? (
          <p data-testid="warm-intro-count" className="text-2xs text-muted">
            {count} matches
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-text-2
                   focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

function ResultsPanel({
  company,
  search,
  onClose,
  onPinSelected,
  onAdd,
}: {
  company: string;
  search: WarmSearchClient;
  onClose: () => void;
  onPinSelected: (selected: WarmCandidate[]) => Promise<boolean>;
  onAdd: (text: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  // Multi-select: a set of candidate identities (`candidateKey`), so a re-render
  // of the same list keeps a checkbox checked even if the array reorders.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [pinning, setPinning] = React.useState(false);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chosen = search.results.filter((c) => selected.has(candidateKey(c)));

  async function pinSelected() {
    if (chosen.length === 0) return;
    setPinning(true);
    const ok = await onPinSelected(chosen);
    setPinning(false);
    if (ok) setSelected(new Set()); // clear only on a clean run
  }

  return (
    <div data-testid="warm-intro-results">
      <PanelHeader company={company} count={search.results.length} onClose={onClose} />
      <p data-testid="warm-intro-searched-for" className="mt-1 text-2xs text-muted">
        Searched for: {searchedForLine(search.params)}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-2xs text-muted">{chosen.length} selected</span>
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid="warm-intro-pin-selected"
          disabled={chosen.length === 0 || pinning}
          onClick={pinSelected}
        >
          {pinning ? "Pinning…" : `Pin selected (${chosen.length})`}
        </Button>
      </div>

      <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
        {search.results.map((c, i) => {
          const key = candidateKey(c);
          return (
            <li
              key={`${key}-${i}`}
              data-testid="warm-intro-candidate"
              className="flex min-w-0 items-start gap-2"
            >
              <input
                type="checkbox"
                data-testid="warm-intro-select"
                checked={selected.has(key)}
                onChange={() => toggle(key)}
                aria-label={`Select ${c.fullName}`}
                className="mt-1 size-3.5 shrink-0"
              />
              <div className="min-w-0 grow">
                <CandidateName candidate={c} />
                {c.headline ? (
                  <p className="truncate text-2xs text-text-2" title={c.headline}>
                    {c.headline}
                  </p>
                ) : null}
                {c.fit || c.signals.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    {/* The LLM fit reason — transparent reasoning, never a bare
                        tier. A subtle chip beside the deterministic signal chips. */}
                    {c.fit ? (
                      <span
                        data-testid="warm-intro-fit"
                        className="rounded border border-border bg-raised px-1 py-0.5 text-2xs text-text-2"
                      >
                        {c.fit.reason}
                      </span>
                    ) : null}
                    {c.signals.map((s, si) => (
                      <span
                        key={`${s.kind}-${s.label}-${si}`}
                        data-testid="warm-intro-signal"
                        className="text-2xs text-muted"
                      >
                        {s.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {c.years ? (
                <span className="shrink-0 text-2xs text-muted">{c.years}</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <AddSomeone onAdd={onAdd} />
    </div>
  );
}

function EmptyPanel({
  company,
  search,
  onClose,
  onAdd,
}: {
  company: string;
  search: WarmSearchClient;
  onClose: () => void;
  onAdd: (text: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <div data-testid="warm-intro-results">
      <PanelHeader company={company} count={null} onClose={onClose} />
      <p data-testid="warm-intro-searched-for" className="mt-1 text-2xs text-muted">
        Searched for: {searchedForLine(search.params)}
      </p>
      <p data-testid="warm-intro-empty" className="mt-2 text-xs text-text-2">
        No matches found.
      </p>
      <AddSomeone onAdd={onAdd} />
    </div>
  );
}

function OverCapPanel({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div>
      <div className="flex items-start gap-2">
        <p data-testid="warm-intro-over-cap" className="min-w-0 text-xs text-text-2">
          {message}
        </p>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-text-2
                     focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function FailedPanel({
  error,
  onRetry,
  onClose,
}: {
  error: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div data-testid="warm-intro-failed">
      <div className="flex items-start gap-2">
        <p className="min-w-0 text-xs text-text-2">That search didn&rsquo;t complete.</p>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-text-2
                     focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {error ? <p className="mt-1 text-2xs text-muted">{error}</p> : null}
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** The "Add someone you know" footer, shared by the results and empty panels. */
function AddSomeone({
  onAdd,
}: {
  onAdd: (text: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === "") return;
    setBusy(true);
    setError(null);
    const result = await onAdd(value);
    setBusy(false);
    if (!result.ok) setError(result.error ?? "That didn't work.");
    // On success the popover closes; nothing more to do here.
  }

  return (
    <form onSubmit={submit} className="mt-3 border-t border-border pt-2">
      <p className="text-2xs text-text-2">Add someone you know</p>
      <div className="mt-1 flex gap-1">
        <input
          data-testid="warm-intro-add-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="LinkedIn URL or a name"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-raised px-2 py-1 text-xs
                     text-text placeholder:text-muted focus-visible:outline-2
                     focus-visible:-outline-offset-1 focus-visible:outline-ring"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          data-testid="warm-intro-add"
          disabled={busy || text.trim() === ""}
        >
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      {error ? (
        <p className="mt-1 text-2xs text-danger" role="alert" data-testid="warm-intro-add-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** A pinned person's name in the idle cell — a link when it is a LinkedIn URL. */
function PinnedName({ pin }: { pin: WarmPinView }) {
  if (isLinkedin(pin.profileUrl)) {
    return (
      <a
        href={pin.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="warm-intro-pin-name"
        title={pin.fullName}
        className="min-w-0 truncate text-xs text-accent hover:underline"
      >
        {pin.fullName}
      </a>
    );
  }
  return (
    <span
      data-testid="warm-intro-pin-name"
      title={pin.fullName}
      className="min-w-0 truncate text-xs text-text-2"
    >
      {pin.fullName}
    </span>
  );
}

/** A candidate's name — a link to their profile when it is a LinkedIn URL, else plain. */
function CandidateName({ candidate }: { candidate: WarmCandidate }) {
  if (isLinkedin(candidate.linkedinUrl)) {
    return (
      <a
        href={candidate.linkedinUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={candidate.fullName}
        className="block truncate text-xs font-medium text-accent hover:underline"
      >
        {candidate.fullName}
      </a>
    );
  }
  return (
    <p className="truncate text-xs font-medium text-text" title={candidate.fullName}>
      {candidate.fullName}
    </p>
  );
}

/** True for an `https://…linkedin.com/…` URL — the only host we render as an outbound link. */
function isLinkedin(url: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(url.trim());
}
