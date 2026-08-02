/**
 * The generated-UI rejection checklist, as computed styles.
 *
 * The design foundations close their checklist with an implementation note:
 * eleven of the twenty-eight tells "should become deterministic checks in CI,
 * the same method as the audit above: walk the DOM, read computed styles, fail
 * the build on a hit". This is that walk. The other seventeen stay review-gate
 * judgment calls, and saying which is which is the point — a checklist where
 * everything is "reviewed" is a checklist nobody runs.
 *
 * Why computed styles rather than a class-name grep: `uppercase tracking-wider`
 * is one spelling of the violation, and a `.ds-styles.css` import, an inline
 * style, a third-party component's own sheet or a `text-transform` inherited
 * from a parent are four others. The browser has already resolved all of them
 * by the time this runs, which is the whole reason the audit this design cites
 * scored 1,590 pages this way instead of reading their source.
 *
 * Why it is a separate file from the spec: `page.evaluate` serialises the
 * function and runs it inside the browser, so it must stay self-contained — no
 * imports, no closure over anything outside its own body. Same arrangement as
 * `painted-overflow.ts`, for the same reason.
 *
 * Every offender names a SELECTOR and quotes the rule, because a failure that
 * says "gradient found" costs an afternoon and one that says
 * `div.hero > span — item 1: Any gradient: backgrounds, text, buttons, borders,
 * glows behind content. Solid tokens only.` costs two minutes.
 */

export type SlopOffender = {
  /** Checklist item number in the design foundations' rejection list. */
  item: number;
  /** Short rule id, for grouping a report. */
  rule: string;
  /** The rule sentence, verbatim, so a fix needs no second document. */
  quote: string;
  /** A CSS-ish path to the element, built from tag/id/class/testid. */
  selector: string;
  /** The computed value that tripped it. */
  value: string;
  /** First ~60 characters of the element's own text, when it has any. */
  text: string;
};

export type SlopOptions = {
  /**
   * Selectors whose subtree is not swept.
   *
   * There is exactly one legitimate kind: content this app renders but does not
   * author. Nothing in the app itself belongs here — a violation in our own
   * markup is a violation.
   */
  skip: string[];
  /**
   * Where to start. Defaults to the whole body, which is what every real sweep
   * uses; the self-test scopes to its own injected fixture so it measures the
   * DETECTOR rather than whatever the page behind it happens to render.
   */
  root?: string;
};

/**
 * Runs INSIDE the browser. Self-contained by necessity (page.evaluate).
 */
export function collectSlop(options: SlopOptions): SlopOffender[] {
  const RULES = {
    gradient: {
      item: 1,
      quote:
        "Any gradient: backgrounds, text, buttons, borders, glows behind content. Solid tokens only.",
    },
    violet: {
      item: 2,
      quote:
        "Violet, lavender, or purple-to-blue anywhere. The single most recognized generated-UI signature.",
    },
    shadow: {
      item: 4,
      quote: "Colored box-shadows or glows; any shadow on a resting element.",
    },
    italic: { item: 7, quote: "Italics, anywhere." },
    titleCase: {
      item: 8,
      quote: "Title case in buttons, headers, or table headers.",
    },
    uppercase: {
      item: 9,
      quote: "Any uppercase text-transform or positive letter-spacing, on anything. No exemptions.",
    },
    tracking: {
      item: 9,
      quote: "Any uppercase text-transform or positive letter-spacing, on anything. No exemptions.",
    },
    figures: {
      item: 12,
      quote: "Proportional figures in any numeric column (check font-variant-numeric).",
    },
    // ── Beyond the numbered checklist ────────────────────────────────────────
    // The rejection checklist is one of two design sources. The build
    // conventions (`project/README.md`) carry three more laws that are just as
    // mechanical, and item 0 marks them as "not from the numbered list" so the
    // checklist-coverage assertion in the spec stays honest about the eleven.
    weight: {
      item: 0,
      quote:
        "README, Type: Weights: `font-medium`, `font-semibold` only — never bold-700, never italics.",
    },
    emDash: {
      item: 0,
      quote: "README, Copy rules: Straight quotes, no exclamation points, no em dashes.",
    },
    accentBorder: {
      item: 16,
      quote:
        "Colored left or top borders on cards or panels, the most specific single tell in the audit data.",
    },
    radius: { item: 19, quote: "Radius above 12px; pill buttons; mixed radii on the same component class." },
    opacity: { item: 25, quote: "Opacity used for de-emphasis (check for opacity-* on text)." },
    glue: {
      item: 27,
      quote:
        "The interpunct, bullet, pipe, or any glyph used as glue between pieces of text. Metadata separates by layout: columns, right-alignment, line breaks, or a comma.",
    },
  } as const;

  const offenders: SlopOffender[] = [];

  const describe = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el, depth = 0; e && depth < 3; e = e.parentElement, depth++) {
      const tag = e.tagName.toLowerCase();
      const testid = e.getAttribute("data-testid");
      const id = e.id ? `#${e.id}` : "";
      const cls = (e.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
      parts.unshift(
        testid ? `${tag}[data-testid="${testid}"]` : `${tag}${id}${cls.length ? `.${cls.join(".")}` : ""}`,
      );
      if (testid || id) break;
    }
    return parts.join(" > ");
  };

  const ownText = (el: Element): string => {
    let t = "";
    for (const n of Array.from(el.childNodes))
      if (n.nodeType === 3) t += n.nodeValue ?? "";
    return t.replace(/\s+/g, " ").trim().slice(0, 60);
  };

  const add = (el: Element, rule: keyof typeof RULES, value: string) => {
    const r = RULES[rule];
    offenders.push({
      item: r.item,
      rule,
      quote: r.quote,
      selector: describe(el),
      value,
      text: ownText(el),
    });
  };

  /** Parse any CSS colour the browser hands back (always rgb/rgba here). */
  const rgb = (value: string): [number, number, number, number] | null => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,/]/).map((s) => parseFloat(s.trim()));
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };

  /**
   * Is this colour in the violet/lavender/purple-to-blue band?
   *
   * Hue alone is not enough: a near-grey with a nominal hue of 280 is a neutral,
   * and this product's neutrals are deliberately warm-tinted. So the test is
   * hue 250-330 AND enough saturation to read as a colour. The accent green
   * (~145) and the info blue (~205) are nowhere near it, which is what makes
   * this checkable at all.
   */
  const isViolet = (value: string): boolean => {
    const c = rgb(value);
    if (!c) return false;
    const [r, g, b, a] = c;
    if (a < 0.15) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 24) return false; // effectively neutral
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
    return h >= 250 && h <= 330;
  };

  /** A shadow that carries a hue, or any shadow at all on a resting element. */
  const shadowIsColored = (value: string): boolean => {
    const c = rgb(value);
    if (!c) return false;
    const [r, g, b, a] = c;
    if (a === 0) return false;
    return Math.max(r, g, b) - Math.min(r, g, b) > 24;
  };

  /**
   * Elements that legitimately float and therefore legitimately cast a shadow:
   * dialogs, popovers, menus, tooltips, toasts. The rule is "any shadow on a
   * RESTING element", so the overlay layer is exactly the exception and it is
   * identified structurally (ARIA role / Radix's own portal attributes) rather
   * than by a hand-kept list of class names.
   */
  const OVERLAY_ROLES = new Set(["dialog", "alertdialog", "menu", "listbox", "tooltip", "status"]);
  const isOverlay = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const role = e.getAttribute("role");
      if (role && OVERLAY_ROLES.has(role)) return true;
      if (e.hasAttribute("data-radix-popper-content-wrapper")) return true;
      if (e.hasAttribute("data-sonner-toaster") || e.hasAttribute("data-sonner-toast")) return true;
      if (getComputedStyle(e).position === "fixed") return true;
    }
    return false;
  };

  /** Text nodes only — an interpunct inside an <svg> path is not glue. */
  const GLUE = /[·•]|\s\|\s/;

  const skipped: Element[] = [];
  for (const sel of options.skip)
    for (const el of Array.from(document.querySelectorAll(sel))) skipped.push(el);
  const isSkipped = (el: Element) => skipped.some((s) => s === el || s.contains(el));

  const rootEl = options.root ? document.querySelector(options.root) : document.body;
  if (!rootEl) return offenders;

  /**
   * Words that are chrome when they appear after the first word in a structural
   * label. A blanket "second capitalized word" check would reject authored data
   * such as "Modern Treasury" and "Product Manager"; this closed vocabulary
   * catches the generated-UI habit without rewriting company names and job
   * titles the product does not own.
   */
  const CHROME_WORDS = new Set([
    "Action",
    "Actions",
    "Answer",
    "Answers",
    "Application",
    "Applications",
    "Board",
    "Boards",
    "Change",
    "Changes",
    "Column",
    "Columns",
    "Company",
    "Companies",
    "Connection",
    "Connections",
    "Decision",
    "Decisions",
    "Detail",
    "Details",
    "Export",
    "Exports",
    "File",
    "Files",
    "Filter",
    "Filters",
    "Import",
    "Imports",
    "Job",
    "Jobs",
    "Profile",
    "Role",
    "Roles",
    "Row",
    "Rows",
    "Search",
    "Seen",
    "Setting",
    "Settings",
    "Status",
    "Statuses",
    "Step",
    "Steps",
    "View",
    "Views",
    "Year",
    "Years",
  ]);
  const titleCaseChrome = (el: Element): string | null => {
    const tag = el.tagName;
    const role = el.getAttribute("role");
    const structural =
      tag === "BUTTON" ||
      tag === "H1" ||
      tag === "H2" ||
      tag === "TH" ||
      role === "heading" ||
      role === "columnheader";
    if (!structural) return null;
    const words = (el.textContent ?? "").replace(/\s+/g, " ").trim().match(/[A-Za-z][A-Za-z'-]*/g);
    if (!words || words.length < 2) return null;
    const hit = words.slice(1).find((word) => CHROME_WORDS.has(word));
    return hit ?? null;
  };

  // Include the root itself. `querySelectorAll("*")` only returns descendants,
  // which let a gradient on body (and a violation on a scoped fixture root)
  // disappear from an otherwise complete walk.
  const elements = [rootEl, ...Array.from(rootEl.querySelectorAll("*"))];
  for (const el of elements) {
    if (isSkipped(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;

    // 1. Gradients, in any of the three properties that can carry one.
    for (const prop of ["backgroundImage", "borderImageSource", "maskImage"] as const) {
      const v = style[prop];
      if (v && v !== "none" && /gradient\(/i.test(v)) add(el, "gradient", `${prop}: ${v.slice(0, 80)}`);
    }

    // 2. Violet / lavender / purple, in text, background, border or shadow.
    for (const [name, v, width] of [
      ["color", style.color, null],
      ["background-color", style.backgroundColor, null],
      ["border-top-color", style.borderTopColor, style.borderTopWidth],
      ["border-right-color", style.borderRightColor, style.borderRightWidth],
      ["border-bottom-color", style.borderBottomColor, style.borderBottomWidth],
      ["border-left-color", style.borderLeftColor, style.borderLeftWidth],
      ["outline-color", style.outlineColor, style.outlineWidth],
      ["fill", style.fill, null],
      ["stroke", style.stroke, null],
    ] as const) {
      // A colour on a zero-width border is not painted.
      if (width !== null && parseFloat(width) === 0) continue;
      if (isViolet(v)) add(el, "violet", `${name}: ${v}`);
    }

    // 4. Shadows. Any shadow at all on a resting element; a COLOURED shadow
    //    anywhere, overlay or not, because a glow is a glow.
    const shadow = style.boxShadow;
    if (shadow && shadow !== "none") {
      if (shadowIsColored(shadow)) add(el, "shadow", `box-shadow: ${shadow.slice(0, 80)}`);
      else if (!isOverlay(el)) add(el, "shadow", `box-shadow: ${shadow.slice(0, 80)}`);
    }

    // 7. Italics.
    if (style.fontStyle === "italic" || style.fontStyle === "oblique")
      add(el, "italic", `font-style: ${style.fontStyle}`);

    // 8. Title case in structural chrome. User/job-board data remains verbatim;
    //    the common chrome-word set above prevents proper names in headings from
    //    being mistaken for labels the app authored.
    const titleCaseHit = titleCaseChrome(el);
    if (titleCaseHit) add(el, "titleCase", `title-cased word: ${titleCaseHit}`);

    // 9. Uppercase and positive letter-spacing. Only where there is text to
    //    transform — a text-transform on an empty wrapper paints nothing.
    const hasText = ownText(el).length > 0;
    if (hasText && style.textTransform !== "none")
      add(el, "uppercase", `text-transform: ${style.textTransform}`);
    if (hasText) {
      const ls = parseFloat(style.letterSpacing);
      if (!Number.isNaN(ls) && ls > 0.01) add(el, "tracking", `letter-spacing: ${style.letterSpacing}`);
    }

    // 12. Proportional figures wherever a digit is painted.
    //
    //     Scope note: the checklist says "any numeric column", and the build
    //     conventions say it wider — "`tabular-nums` on every element whose
    //     text contains a digit" (README, Spacing). The wider one governs,
    //     because the narrow reading let every digit outside a table — counts
    //     in buttons, timestamps in the pane, meter readouts — ship
    //     proportional, and those are the digits that visibly jitter when a
    //     value updates in place.
    //
    //     A digit is only a figure when it is a figure a reader reads: a lone
    //     digit inside a word the app does not set as data (an id fragment, a
    //     `h2`) is not, so the test is on the element's OWN text, which is the
    //     text this element is responsible for painting.
    if (hasText && /\d/.test(ownText(el)) && !/tabular-nums/.test(style.fontVariantNumeric))
      add(el, "figures", `font-variant-numeric: ${style.fontVariantNumeric || "normal"}`);

    // Weights. The type scale ships two: 500 and 600. 400 is the inherited body
    // default and is what unstyled prose legitimately resolves to, so the ban is
    // on everything ABOVE 600 (the bold-700 the README names) and on the
    // in-between values a stray `font-weight` lands on.
    if (hasText) {
      const w = parseInt(style.fontWeight, 10);
      if (!Number.isNaN(w) && w !== 400 && w !== 500 && w !== 600)
        add(el, "weight", `font-weight: ${style.fontWeight}`);
    }

    // Em dashes, in the RENDERED text. The copy lint reads source literals; a
    // dash that arrives inside job-board data, or through a string this app
    // assembles at runtime, reaches the screen without passing that lint. The
    // en dash is untouched: the copy rules keep it for numeric ranges.
    if (hasText && /—/.test(ownText(el))) add(el, "emDash", JSON.stringify(ownText(el)));

    // 16. Coloured left or top borders on a card or panel — a border that is
    //     thicker than a hairline AND a different colour from the element's
    //     other sides is the accent-stripe shape the audit names.
    const lw = parseFloat(style.borderLeftWidth);
    const tw = parseFloat(style.borderTopWidth);
    if (lw >= 2 && style.borderLeftColor !== style.borderRightColor)
      add(el, "accentBorder", `border-left: ${style.borderLeftWidth} ${style.borderLeftColor}`);
    if (tw >= 2 && style.borderTopColor !== style.borderBottomColor)
      add(el, "accentBorder", `border-top: ${style.borderTopWidth} ${style.borderTopColor}`);

    // 19. Radius above 12px. Percentages and the full-round pill idiom are how
    //     it usually arrives; both resolve to a large px value here. A circle —
    //     an avatar, a status dot, a spinner — is not the pill this bans, so a
    //     square element whose radius is at least half its size is exempt.
    const r = Math.max(
      parseFloat(style.borderTopLeftRadius),
      parseFloat(style.borderTopRightRadius),
      parseFloat(style.borderBottomLeftRadius),
      parseFloat(style.borderBottomRightRadius),
    );
    if (!Number.isNaN(r) && r > 12) {
      const box = el.getBoundingClientRect();
      const circular =
        Math.abs(box.width - box.height) <= 1 && r >= Math.min(box.width, box.height) / 2 - 0.5;
      if (!circular) add(el, "radius", `border-radius: ${style.borderTopLeftRadius}`);
    }

    // 25. Opacity used to de-emphasise text. An element with its own text and a
    //     partial opacity is the exact shape the rule names; a partially-opaque
    //     container mid-transition is not, so this only fires where text lives.
    //
    //     A DISABLED control is carved out, narrowly and on purpose. The rule's
    //     own parenthetical is "check for opacity-* on text", and its target is
    //     muted body copy dimmed instead of coloured — the failure this repo
    //     already hit once on Kbd. A disabled button is a state, not a
    //     de-emphasised label; WCAG exempts disabled controls from contrast for
    //     the same reason. The carve-out is `:disabled` only, so a
    //     `text-muted opacity-60` label gets no cover from it.
    const op = parseFloat(style.opacity);
    const disabled = el.matches(':disabled, [aria-disabled="true"], [data-disabled]');
    const containsText = (el.textContent ?? "").replace(/\s+/g, " ").trim().length > 0;
    if (containsText && !disabled && !Number.isNaN(op) && op < 1 && op > 0)
      add(el, "opacity", `opacity: ${style.opacity}`);

    // 27. The interpunct, bullet, or pipe used as glue — read off TEXT NODES,
    //     so a glyph inside an icon font or an svg is not a hit.
    const own = ownText(el);
    if (own && GLUE.test(own)) add(el, "glue", JSON.stringify(own));
  }

  return offenders;
}

/** Turn offenders into the actionable message: selector, value, rule quoted. */
export function describeSlop(offenders: SlopOffender[]): string {
  if (!offenders.length) return "";
  const shown = offenders.slice(0, 20);
  const lines = shown.map(
    (o) =>
      `  [item ${o.item} / ${o.rule}] ${o.selector}\n` +
      `      value : ${o.value}\n` +
      (o.text ? `      text  : ${JSON.stringify(o.text)}\n` : "") +
      `      rule  : ${o.quote}`,
  );
  const more = offenders.length - shown.length;
  return (
    `${offenders.length} generated-UI tell(s) in the rendered page:\n` +
    lines.join("\n") +
    (more > 0 ? `\n  ...and ${more} more` : "")
  );
}
