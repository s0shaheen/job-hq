/**
 * The heading outline, as an explicit sweep.
 *
 * ── WHY THIS IS NOT A WIDER AXE CONFIGURATION ────────────────────────────────
 *
 * The obvious build is to add `best-practice` to the nine `AxeBuilder` calls in
 * this suite and drop their `serious|critical` filter. That was rejected, and
 * the reason is not taste — it is that widening axe cannot catch the whole set
 * this gate owes.
 *
 * What axe would still have missed:
 *
 *   * A DUPLICATE `h1`. axe has no rule for it at any tag or impact.
 *     `page-has-heading-one` asserts at least one `h1` and is satisfied by five.
 *     A surface that grows a second page title is invisible to axe forever.
 *   * A surface with NO heading at all. `page-has-heading-one` covers the
 *     document, but the failure this estate actually ships is a PANE or a
 *     dialog rendering headingless content into a page whose `h1` is elsewhere;
 *     scoping the check is the point, and axe scopes to the document.
 *   * The regression class the filters hide. `heading-order` is `moderate` and
 *     `page-has-heading-one` is `moderate` best-practice, so each is excluded
 *     TWICE over by the existing calls — by tag and by impact. Fixing that means
 *     editing nine call sites and remembering to configure the tenth correctly
 *     the day it is written. A gate whose correctness depends on every future
 *     author repeating a configuration is the shape of the hole this closes.
 *
 * What the axe route would have caught that this sweep must therefore implement
 * itself, and does: an empty heading, and headings expressed as
 * `role="heading"` with `aria-level` rather than as `h1`-`h6`.
 *
 * Same self-contained `page.evaluate` arrangement as `computed-slop.ts`.
 */

export type HeadingNode = {
  level: number;
  text: string;
  selector: string;
};

export type OutlineFinding = {
  /** Short rule id. */
  rule: "no-heading" | "no-h1" | "duplicate-h1" | "level-skip" | "empty-heading";
  /** What is wrong, in a sentence, naming the offending heading. */
  detail: string;
};

export type Outline = {
  headings: HeadingNode[];
  findings: OutlineFinding[];
};

export type OutlineOptions = {
  /** Subtrees not swept. Same contract as the other sweeps. */
  skip: string[];
  /** Where to start. Defaults to the whole body. */
  root?: string;
  /**
   * Require a level-1 heading in this scope. True for a page; false for a
   * scoped region such as an open dialog, which owes an outline but not an
   * `h1`.
   */
  requireH1: boolean;
};

/** Runs INSIDE the browser. Self-contained by necessity (page.evaluate). */
export function collectOutline(options: OutlineOptions): Outline {
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

  /**
   * Hidden from the accessibility tree, and therefore not in the outline.
   *
   * `display:none`, `visibility:hidden`, `hidden`, `inert` and `aria-hidden`
   * only. A VISUALLY hidden heading (`sr-only`: clipped, 1px, absolute) is a
   * real heading in a real outline and must stay in the walk — dropping it
   * would make an accessible page look like a skip.
   */
  const isExposed = (el: Element): boolean => {
    // `role="presentation"` strips the ELEMENT's own semantics and not its
    // descendants', so it is checked here rather than in the ancestor walk
    // below. A `<div role="presentation">` wrapping a section still contains
    // that section's headings, and dropping them would report a sound outline
    // as a level skip.
    const ownRole = el.getAttribute("role");
    if (ownRole === "presentation" || ownRole === "none") return false;
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

  const skipped: Element[] = [];
  for (const sel of options.skip)
    for (const el of Array.from(document.querySelectorAll(sel))) skipped.push(el);
  const isSkipped = (el: Element) => skipped.some((s) => s === el || s.contains(el));

  const rootEl = options.root ? document.querySelector(options.root) : document.body;
  if (!rootEl) return { headings: [], findings: [] };

  const SELECTOR = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const candidates = Array.from(rootEl.querySelectorAll(SELECTOR));
  if (rootEl.matches(SELECTOR)) candidates.unshift(rootEl);

  const headings: HeadingNode[] = [];
  const findings: OutlineFinding[] = [];

  for (const el of candidates) {
    if (isSkipped(el)) continue;
    if (!isExposed(el)) continue;
    // `aria-level` wins over the tag, which is what an assistive technology
    // does. A `role=heading` with no `aria-level` is level 2 per ARIA.
    const ariaLevel = parseInt(el.getAttribute("aria-level") ?? "", 10);
    const tagLevel = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : NaN;
    const level = Number.isFinite(ariaLevel) ? ariaLevel : Number.isFinite(tagLevel) ? tagLevel : 2;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const selector = describe(el);
    if (!text) {
      findings.push({
        rule: "empty-heading",
        detail: `${selector} is a level-${level} heading with no text, so it announces a section that has no name`,
      });
      continue;
    }
    headings.push({ level, text: text.slice(0, 80), selector });
  }

  if (headings.length === 0) {
    findings.push({
      rule: "no-heading",
      detail:
        "this scope renders no heading at all, so there is nothing for a screen reader to navigate by",
    });
    return { headings, findings };
  }

  const h1s = headings.filter((h) => h.level === 1);
  if (options.requireH1 && h1s.length === 0) {
    findings.push({
      rule: "no-h1",
      detail:
        `no level-1 heading; the outline starts at level ${headings[0].level} ` +
        `(${headings[0].selector} ${JSON.stringify(headings[0].text)})`,
    });
  }
  if (h1s.length > 1) {
    findings.push({
      rule: "duplicate-h1",
      detail:
        `${h1s.length} level-1 headings, so the page claims more than one title: ` +
        h1s.map((h) => `${h.selector} ${JSON.stringify(h.text)}`).join(", "),
    });
  }

  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1];
    const here = headings[i];
    if (here.level > prev.level + 1) {
      findings.push({
        rule: "level-skip",
        detail:
          `level ${prev.level} -> ${here.level} skips level ${prev.level + 1}: ` +
          `${here.selector} ${JSON.stringify(here.text)} follows ` +
          `${prev.selector} ${JSON.stringify(prev.text)}`,
      });
    }
  }

  return { headings, findings };
}

export function describeOutline(outline: Outline): string {
  if (!outline.findings.length) return "";
  const problems = outline.findings.map((f) => `  [${f.rule}] ${f.detail}`).join("\n");
  const shape = outline.headings
    .map((h) => `  ${"  ".repeat(Math.max(0, h.level - 1))}h${h.level} ${JSON.stringify(h.text)}  ${h.selector}`)
    .join("\n");
  return (
    `${outline.findings.length} heading-outline finding(s):\n${problems}\n\n` +
    `the outline as rendered:\n${shape || "  (none)"}`
  );
}
