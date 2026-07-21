/**
 * Painted-geometry overflow detection, shared by the layout and resilience
 * suites.
 *
 * Why not `document.documentElement.scrollWidth`? Because globals.css sets
 * `overflow-x: hidden` on html and body, which PINS scrollWidth to the
 * viewport width no matter how far content actually extends. That converts
 * "the page scrolls sideways" into "the content is silently clipped" — the
 * user still cannot reach it, and a scrollWidth assertion passes
 * unconditionally. This was measured, not hypothesised: an element ending at
 * x=1410 inside a 375px viewport reported docScrollWidth 375. So the check
 * walks every painted element and compares its real geometry against the
 * viewport box instead.
 *
 * The function runs inside the browser via page.evaluate, so it must stay
 * self-contained: no references to anything outside its own body.
 */

export type PaintedOverflowOffender = {
  tag: string;
  cls: string;
  left: number;
  /** Right edge of what the element PAINTS — its border box, extended by any
   *  visible overflow (an unbroken token spilling out of a block widens what
   *  is painted without widening the box). */
  paintedRight: number;
  viewport: number;
};

export function collectPaintedOverflow(): PaintedOverflowOffender[] {
  const vw = document.documentElement.clientWidth;
  const offenders: {
    tag: string;
    cls: string;
    left: number;
    paintedRight: number;
    viewport: number;
  }[] = [];

  // An element whose box lies beyond the viewport is fine when an ANCESTOR
  // manages that overflow: a table cell inside an `overflow-x-auto` region is
  // reachable by that region's own scrollbar, and content inside a component's
  // deliberate `overflow-hidden` (a truncated line, rounded-corner clipping)
  // never paints outside it. html and body do NOT count as managers — their
  // `overflow-x: hidden` is exactly the failure this check exists to see
  // through. Fixed-position elements escape ancestor clipping entirely, so
  // they get no excuse.
  const managedByAncestor = (el: Element): boolean => {
    if (getComputedStyle(el).position === "fixed") return false;
    for (
      let p = el.parentElement;
      p && p !== document.body && p !== document.documentElement;
      p = p.parentElement
    ) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };

  for (const el of Array.from(document.querySelectorAll("*"))) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // paints nothing
    if (managedByAncestor(el)) continue;

    // Visible overflow paints beyond the border box without widening it, so
    // getBoundingClientRect alone misses a long token spilling out of a
    // heading. scrollWidth includes that content (and is 0 for plain inline
    // boxes, which is harmless under Math.max).
    const paintedRight =
      style.overflowX === "visible" ? Math.max(r.right, r.left + el.scrollWidth) : r.right;

    // 1px of slack for sub-pixel rounding; the failures this hunts are tens
    // to hundreds of pixels.
    if (paintedRight > vw + 1 || r.left < -1) {
      offenders.push({
        tag: el.tagName,
        cls: (el.getAttribute("class") ?? "").slice(0, 80),
        left: Math.round(r.left),
        paintedRight: Math.round(paintedRight),
        viewport: vw,
      });
    }
  }
  return offenders;
}

/** Turn offenders into the actionable message the old check promised:
 *  name the element, so a failure is a two-minute fix rather than just red. */
export function describeOffenders(offenders: PaintedOverflowOffender[]): string {
  return offenders
    .slice(0, 5)
    .map(
      (o) =>
        `<${o.tag} class="${o.cls}"> paints from x=${o.left} to x=${o.paintedRight} ` +
        `in a ${o.viewport}px viewport`,
    )
    .join("\n");
}
