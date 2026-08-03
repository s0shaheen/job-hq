/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA — as a computed-geometry sweep.
 *
 * `04-design-parity-standard.md` claims WCAG 2.2 AA. Nothing in this estate
 * measured a pointer target until this file, and nothing could have: axe-core
 * ships NO rule for 2.5.8 at any tag or impact, so every axe call in
 * `tests/e2e/**` was blind to it by construction rather than by configuration.
 * The cost was paid several times in one session, each time by a human reading
 * a diff rather than by a gate: a 32x18 switch shipped once per grid row, a
 * `pane-close` at 16x16 that was a pane's only pointer dismiss, a
 * `group-toggle` at 70.9x16, and two controls 20px tall.
 *
 * Same arrangement as `computed-slop.ts` and `painted-overflow.ts`, for the
 * same reason: `page.evaluate` serialises the function and runs it inside the
 * browser, so it must stay self-contained — no imports, no closure over
 * anything outside its own body.
 *
 * ── Why the exceptions are implemented rather than approximated ──────────────
 *
 * The criterion has five exceptions and this file implements three of them
 * mechanically plus a declared hatch for the two that are not machine-decidable.
 * That is not thoroughness for its own sake: a rule with wrong exceptions
 * produces failures a reviewer knows are wrong, and a rule whose failures are
 * known to be wrong gets waived into uselessness inside a week. The known
 * false-positive classes here are icon buttons spaced apart in a toolbar
 * (spacing), a link inside a sentence (inline), and a native checkbox (user
 * agent) — all three are legitimate passes under the criterion, and all three
 * would otherwise be the first entries on a blanket allowlist.
 *
 * Every offender reports WHICH exception it failed to qualify for and why,
 * because a failure that does not say why is a failure someone waives.
 */

export type TargetBox = { x: number; y: number; w: number; h: number };

export type TargetOffender = {
  /** A CSS-ish path to the element, built from tag/id/class/testid. */
  selector: string;
  /** First ~60 characters of the element's label or text. */
  text: string;
  /** The measured target box, in CSS pixels, including hit-area pseudo-elements. */
  box: TargetBox;
  /**
   * One line per exception, in the criterion's own order, each saying why it
   * did NOT apply. An offender is only an offender because all of these failed.
   */
  exceptions: string[];
};

export type TargetOptions = {
  /**
   * Selectors whose subtree is not swept. Same contract as the slop sweep: the
   * only legitimate kind of entry is markup this app renders but does not
   * author, and an entry needs a comment naming what will resolve it.
   */
  skip: string[];
  /**
   * Where to start. Defaults to the whole body. The self-test scopes to its own
   * injected fixture so it measures the DETECTOR — and, for the spacing
   * exception specifically, so the neighbour set is the fixture's own targets
   * rather than whatever the page behind it happens to render.
   */
  root?: string;
};

/** Runs INSIDE the browser. Self-contained by necessity (page.evaluate). */
export function collectTargets(options: TargetOptions): TargetOffender[] {
  const MIN = 24;

  /**
   * What counts as a pointer target.
   *
   * WCAG defines a target as the "region of the display that will accept a
   * pointer action". There is no computed property for that, so this is the
   * union of the native interactive elements and the ARIA widget roles that
   * take a click, plus anything the author put in the tab order or wired to a
   * click handler. `tabindex="-1"` is excluded: it is reachable by script
   * focus, not by a pointer action.
   */
  const TARGET_SELECTOR = [
    "a[href]",
    "area[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[contenteditable=true]",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="combobox"]',
    '[role="treeitem"]',
    "[onclick]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  const describe = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el, depth = 0; e && depth < 3; e = e.parentElement, depth++) {
      const tag = e.tagName.toLowerCase();
      const testid = e.getAttribute("data-testid");
      const id = e.id ? `#${e.id}` : "";
      const cls = (e.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
      parts.unshift(
        testid
          ? `${tag}[data-testid="${testid}"]`
          : `${tag}${id}${cls.length ? `.${cls.join(".")}` : ""}`,
      );
      if (testid || id) break;
    }
    return parts.join(" > ");
  };

  const label = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    const raw = aria && aria.trim() ? aria : (el.textContent ?? "");
    return raw.replace(/\s+/g, " ").trim().slice(0, 60);
  };

  const round = (n: number) => Math.round(n * 100) / 100;

  /**
   * The target box.
   *
   * `getBoundingClientRect` is the ELEMENT; the TARGET is the region that
   * accepts the pointer, and the standard way to enlarge one without enlarging
   * the visual control is an absolutely positioned pseudo-element with negative
   * insets. Nothing in this app uses that today. It is measured anyway, because
   * the day someone adds it the alternative is a gate reporting a fixed control
   * as still broken — and a gate that is wrong about a fix is a gate that gets
   * deleted.
   */
  const boxOf = (el: Element): TargetBox => {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let right = r.right;
    let bottom = r.bottom;
    for (const pseudo of ["::before", "::after"]) {
      const s = getComputedStyle(el, pseudo);
      if (s.content === "none" || s.content === "normal") continue;
      if (s.position !== "absolute") continue;
      const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : NaN);
      const t = px(s.top);
      const l = px(s.left);
      const rt = px(s.right);
      const b = px(s.bottom);
      if (Number.isFinite(t) && t < 0) y = Math.min(y, r.top + t);
      if (Number.isFinite(l) && l < 0) x = Math.min(x, r.left + l);
      if (Number.isFinite(rt) && rt < 0) right = Math.max(right, r.right - rt);
      if (Number.isFinite(b) && b < 0) bottom = Math.max(bottom, r.bottom - b);
    }
    return { x: round(x), y: round(y), w: round(right - x), h: round(bottom - y) };
  };

  /** Rendered at all? A target nobody can point at is not a target. */
  const isRendered = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse")
        return false;
      if (e.getAttribute("aria-hidden") === "true") return false;
      if (e.hasAttribute("hidden")) return false;
      if (e.hasAttribute("inert")) return false;
    }
    return true;
  };

  /**
   * A disabled control accepts no pointer action, so it is not a target.
   * `aria-disabled` is NOT treated the same way: it still takes the click in
   * every browser, so it stays in scope.
   */
  const isDisabled = (el: Element): boolean =>
    (el as HTMLInputElement).disabled === true || el.closest("fieldset[disabled]") !== null;

  /**
   * The user-agent exception: "the size of the target is determined by the user
   * agent and is not modified by the author."
   *
   * Answered by MEASURING the user agent's own default rather than by guessing
   * from a tag name or by scanning stylesheets for sizing declarations. The
   * scan was written first and thrown away: Tailwind's preflight sets
   * `padding: 0` and `appearance: button` on every input and button, so a
   * declaration scan revokes the exception for every native control in the app
   * and turns a correct exception into a blanket denial — a rule that is wrong
   * about a conforming control is a rule that gets waived.
   *
   * A probe of the same tag and `type` is rendered inside a SHADOW ROOT on a
   * host with `all: initial`. Author styles do not cross a shadow boundary, so
   * what comes back is the browser's default box and nothing else. If the real
   * control measures the same, the author did not modify its size.
   *
   * Only the controls whose default size is content-INDEPENDENT are eligible.
   * A `<button>`'s or a `<select>`'s default size follows its content, so
   * nothing about it is "determined by the user agent" in the sense the
   * exception means, and it is never granted.
   */
  const UA_SIZED = new Set(["checkbox", "radio", "color", "range"]);
  const uaCache: Record<string, { w: number; h: number }> = {};
  const uaDefaultBox = (el: Element): { w: number; h: number } | null => {
    if (el.tagName !== "INPUT") return null;
    const type = ((el as HTMLInputElement).getAttribute("type") ?? "text").toLowerCase();
    if (!UA_SIZED.has(type)) return null;
    if (uaCache[type]) return uaCache[type];
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:absolute;left:-99999px;top:0";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const probe = document.createElement("input");
    probe.setAttribute("type", type);
    shadow.appendChild(probe);
    const r = probe.getBoundingClientRect();
    const out = { w: round(r.width), h: round(r.height) };
    host.remove();
    uaCache[type] = out;
    return out;
  };

  /** Circle (centre cx,cy, radius r) vs rectangle. Touching is not intersecting. */
  const circleHitsRect = (cx: number, cy: number, r: number, b: TargetBox): boolean => {
    const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
    const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
    return Math.hypot(cx - nx, cy - ny) < r;
  };

  const skipped: Element[] = [];
  for (const sel of options.skip)
    for (const el of Array.from(document.querySelectorAll(sel))) skipped.push(el);
  const isSkipped = (el: Element) => skipped.some((s) => s === el || s.contains(el));

  const rootEl = options.root ? document.querySelector(options.root) : document.body;
  if (!rootEl) return [];

  const candidates = Array.from(rootEl.querySelectorAll(TARGET_SELECTOR));
  if (rootEl.matches(TARGET_SELECTOR)) candidates.unshift(rootEl);

  type Target = { el: Element; box: TargetBox };
  const targets: Target[] = [];
  for (const el of candidates) {
    if (isSkipped(el)) continue;
    if (isDisabled(el)) continue;
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") continue;
    if (!isRendered(el)) continue;
    const box = boxOf(el);
    if (box.w <= 0 || box.h <= 0) continue;
    targets.push({ el, box });
  }

  const offenders: TargetOffender[] = [];
  for (const t of targets) {
    if (t.box.w >= MIN && t.box.h >= MIN) continue;
    const exceptions: string[] = [];

    // ── 1. Spacing ──────────────────────────────────────────────────────────
    // "if a 24 CSS pixel diameter circle is centered on the bounding box of
    // each, the circles do not intersect another target or the circle of
    // another undersized target."
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    let crowdedBy: Target | null = null;
    for (const o of targets) {
      if (o === t) continue;
      // An ancestor or descendant is not an ADJACENT target: the browser's own
      // hit testing gives the innermost element the pixel, so the two never
      // compete for one point and no amount of spacing would change that. The
      // criterion is about crowding between targets on the surface.
      if (o.el.contains(t.el) || t.el.contains(o.el)) continue;
      const undersized = o.box.w < MIN || o.box.h < MIN;
      const ox = o.box.x + o.box.w / 2;
      const oy = o.box.y + o.box.h / 2;
      const hit = undersized
        ? Math.hypot(cx - ox, cy - oy) < MIN
        : circleHitsRect(cx, cy, MIN / 2, o.box);
      if (hit) {
        crowdedBy = o;
        break;
      }
    }
    if (!crowdedBy) continue;
    exceptions.push(
      `spacing: a ${MIN}px circle centred here intersects ${describe(crowdedBy.el)} ` +
        `(${crowdedBy.box.w}x${crowdedBy.box.h} at ${crowdedBy.box.x},${crowdedBy.box.y})`,
    );

    // ── 2. Inline ───────────────────────────────────────────────────────────
    // "The target is in a sentence or its size is otherwise constrained by the
    // line-height of non-target text."
    const display = getComputedStyle(t.el).display;
    const parent = t.el.parentElement;
    let sentenceText = "";
    if (parent) {
      for (const n of Array.from(parent.childNodes)) {
        if (n === t.el) continue;
        if (n.nodeType === 3) sentenceText += n.nodeValue ?? "";
        else if (n.nodeType === 1 && !(n as Element).matches(TARGET_SELECTOR))
          sentenceText += (n as Element).textContent ?? "";
      }
    }
    if (display === "inline" && sentenceText.trim().length > 0) continue;
    exceptions.push(
      display !== "inline"
        ? `inline: display is "${display}", not "inline", so its size is not constrained by ` +
            `the line-height of surrounding text`
        : `inline: display is "inline" but the parent holds no non-target text, so this is not ` +
            `a target in a sentence`,
    );

    // ── 3. User agent ───────────────────────────────────────────────────────
    // "The size of the target is determined by the user agent and is not
    // modified by the author."
    const uaBox = uaDefaultBox(t.el);
    const rect = t.el.getBoundingClientRect();
    const matchesUa =
      uaBox !== null &&
      Math.abs(round(rect.width) - uaBox.w) < 0.5 &&
      Math.abs(round(rect.height) - uaBox.h) < 0.5;
    if (matchesUa) continue;
    exceptions.push(
      uaBox === null
        ? `user agent: <${t.el.tagName.toLowerCase()}${
            t.el.tagName === "INPUT" ? ` type=${(t.el as HTMLInputElement).type}` : ""
          }> has no content-independent user-agent size, so nothing about its box comes from ` +
            `the user agent`
        : `user agent: the author sizes this control — it renders ${round(rect.width)}x${round(
            rect.height,
          )} where the user-agent default is ${uaBox.w}x${uaBox.h}`,
    );

    // ── 4/5. Essential and equivalent ───────────────────────────────────────
    // Neither is machine-decidable: "essential" is a claim about the design and
    // "equivalent" is a claim about a different control elsewhere on the page.
    // Both are therefore DECLARED in the markup, with a reason, following the
    // assertion lint's waiver shape — a bare escape hatch with no reason is how
    // a gate quietly stops gating.
    const declared = t.el.getAttribute("data-target-size-exception") ?? "";
    const m = declared.match(/^(essential|equivalent):\s*([\s\S]*)$/);
    if (m && m[2].trim().length >= 20) continue;
    exceptions.push(
      !declared
        ? `essential/equivalent: no data-target-size-exception="essential|equivalent: <reason>" ` +
            `on this element`
        : !m
          ? `essential/equivalent: data-target-size-exception must start with "essential:" or ` +
            `"equivalent:", got ${JSON.stringify(declared.slice(0, 40))}`
          : `essential/equivalent: the declared reason is under 20 characters`,
    );

    offenders.push({ selector: describe(t.el), text: label(t.el), box: t.box, exceptions });
  }

  return offenders;
}

export function describeTargets(offenders: TargetOffender[]): string {
  if (!offenders.length) return "";
  const shown = offenders.slice(0, 20);
  const lines = shown.map((o) => {
    const why = o.exceptions.map((e) => `        - ${e}`).join("\n");
    return (
      `  ${o.selector}\n` +
      `      measured : ${o.box.w} x ${o.box.h} CSS px (needs 24 x 24)\n` +
      (o.text ? `      text     : ${JSON.stringify(o.text)}\n` : "") +
      `      exceptions it does not qualify for:\n${why}`
    );
  });
  const more = offenders.length - shown.length;
  return (
    `${offenders.length} pointer target(s) under 24x24 CSS px — ` +
    `WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA:\n` +
    lines.join("\n") +
    (more > 0 ? `\n  ...and ${more} more` : "")
  );
}
