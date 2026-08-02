/**
 * Pulling the USER-FACING strings out of a TSX/TS file.
 *
 * The whole difficulty of a copy lint is that a source file is mostly not copy:
 * import specifiers, testids, CSS class names, enum values, SQL fragments and
 * `data-*` attributes are all string literals, and none of them is read by a
 * person. A naive grep over quoted text produces a report nobody reads, which is
 * the same as no gate at all.
 *
 * So this walks the TypeScript AST and takes a string only when its POSITION
 * says a person will read it:
 *
 *   1. JSX text — the characters between tags.
 *   2. A string or template literal inside a JSX expression container, which is
 *      how conditional copy is written (`{n === 1 ? "row" : "rows"}`).
 *   3. A JSX attribute whose name is in `COPY_ATTRIBUTES` — `title`, `body`,
 *      `placeholder`, `aria-label` and the component props this app renders
 *      verbatim (EmptyState's `title`/`body`, the toast's `description`).
 *   4. Arguments to `toast(...)` and friends, which land on screen unmodified.
 *   5. In the dictionary modules, the return values and the label maps — the
 *      view-model edge, where every surface's words are actually chosen.
 *
 * Deliberately NOT extracted: `className`, `data-testid`, `key`, `href`, `id`,
 * `name`, `type`, `role`, import paths, object keys, and any literal whose text
 * carries no lowercase letter pair (a token like "NEEDS_INFO" is a value, not a
 * sentence). Each of those is a decision that trades recall for a report a human
 * will actually act on; the DOM sweep in tests/e2e/slop.spec.ts is the recall
 * half of the pair, since it reads what actually rendered.
 */

import ts from "typescript";

/**
 * JSX attributes whose value is rendered as words.
 *
 * `title` is both an HTML tooltip and this app's EmptyState heading prop; both
 * are copy. `alt` is copy for the same reason. The rest are props this codebase
 * defines and renders verbatim — grep for them before adding one, because an
 * attribute added here that is NOT rendered produces false failures on strings
 * nobody sees.
 */
export const COPY_ATTRIBUTES = new Set([
  "title",
  "body",
  "label",
  "placeholder",
  "alt",
  "heading",
  "hint",
  "description",
  "summary",
  "message",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-placeholder",
  "aria-valuetext",
]);

/** Call expressions whose string arguments reach the screen. */
const COPY_CALLEES = new Set([
  "toast",
  "toast.success",
  "toast.error",
  "toast.message",
  "toast.warning",
  "toast.info",
]);

/** JSON response objects whose named fields are rendered by the caller. */
const RESPONSE_CALLEES = new Set(["NextResponse.json", "Response.json"]);
const RESPONSE_COPY_KEYS = new Set(["error", "message", "detail", "description", "title", "body"]);

/**
 * Files where the label vocabulary itself lives — the view-model edge the design
 * calls "the display dictionary". In these, a returned string and a `*LABELS*`
 * map value are copy even though no JSX is in sight.
 */
export const DICTIONARY_FILES = [
  "lib/data/view-models.ts",
  "lib/grid/columns.tsx",
  "lib/grid/company-columns.tsx",
  "lib/grid/filter.ts",
  "lib/grid/presets.ts",
  "lib/grid/company-presets.ts",
  "lib/status.ts",
  "lib/apply/topics.ts",
  "lib/profile/preview.ts",
  "lib/export/columns.ts",
];

/** A literal with no lowercase run is a token (NEEDS_INFO, csv, ok), not a sentence. */
function looksLikeCopy(text) {
  const t = text.trim();
  if (t.length < 2) return false;
  return /[a-z]{2}/.test(t);
}

/**
 * Property keys whose VALUE is styling, never words.
 *
 * `className` is already skipped as a JSX attribute, but third-party components
 * (sonner's toaster, radix slots) take a `classNames` OBJECT as a prop, and its
 * values live inside a JSX expression like any other literal. Tailwind's
 * important modifier makes `!bg-surface` look like an exclamation point in
 * interface copy. Found by the rule firing on it.
 */
const STYLE_KEYS = new Set(["className", "classNames", "class", "style", "cn"]);

/**
 * Is this literal a VALUE being compared, rather than words being shown?
 *
 * `{triage === "snoozed" ? <Badge/> : null}` puts an engine token inside a JSX
 * expression container, and the token is exactly right there — it is the column
 * name, not the label. Extracting it produced a report where two thirds of the
 * hits were the code doing its job, which is how a lint gets ignored. A literal
 * is a value, not copy, when it is:
 *
 *   an operand of ===/!==/==/!=      `set === "snoozed"`
 *   a `case` label                    `case "snoozed":`
 *   an argument to any call that is   `decide(current, "dismissed")`
 *     not a known copy sink            `.includes("snoozed")`, `cn(...)`
 *   the value of a styling prop       `classNames: { toast: "!bg-surface" }`
 *
 * The call-argument rule is the widest of these and the one that earns its keep:
 * a handler taking `"dismissed"` is passing the stored token to the write path,
 * which is exactly correct, and it was two thirds of the noise. What it gives up
 * is copy passed into a helper that renders it — and the DOM sweep reads the
 * rendered page, so that half is covered by the other check rather than lost.
 * `toast(...)` is exempt because it is a copy sink with no rendering step to
 * observe it in.
 *
 * Everything else inside a JSX expression is presumed to reach the screen, which
 * is the right default: a false positive costs one allowlist entry with a reason,
 * a false negative ships a banned word.
 */
const MEMBERSHIP_METHODS = new Set([
  "includes",
  "has",
  "startsWith",
  "endsWith",
  "indexOf",
  "match",
  "test",
]);

function isValueNotCopy(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (
        k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        k === ts.SyntaxKind.EqualsEqualsToken ||
        k === ts.SyntaxKind.ExclamationEqualsToken
      )
        return true;
      // A `+` chain or a `??`/`||` fallback is still copy; keep walking out.
    }
    if (ts.isCaseClause(p)) return true;
    if (ts.isCallExpression(p)) {
      const e = p.expression;
      if (ts.isPropertyAccessExpression(e) && MEMBERSHIP_METHODS.has(e.name.text)) return true;
      return !isCopyCallee(calleeName(p));
    }
    if (ts.isPropertyAssignment(p)) {
      if (p.name === node) return true;
      const key = p.name.getText().replace(/["']/g, "");
      if (STYLE_KEYS.has(key)) return true;
    }
    if (ts.isJsxExpression(p) || ts.isJsxAttribute(p) || ts.isReturnStatement(p)) return false;
  }
  return false;
}

function isCopyCallee(name) {
  return COPY_CALLEES.has(name) || RESPONSE_CALLEES.has(name);
}

function calleeName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression))
    return `${e.expression.text}.${e.name.text}`;
  return "";
}

/** Every string-ish literal reachable from a node, including template spans. */
function literalsUnder(node, out) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push({ text: node.text, pos: node.getStart(), node });
    return;
  }
  if (ts.isTemplateExpression(node)) {
    // Template SPANS only: the interpolated expressions are values, and a
    // `${count} rows` string must be judged on the literal halves. Joining the
    // spans would invent adjacencies (and a false interpunct hit) that the
    // rendered string never has.
    if (node.head.text) out.push({ text: node.head.text, pos: node.head.getStart(), node });
    for (const span of node.templateSpans)
      if (span.literal.text)
        out.push({ text: span.literal.text, pos: span.literal.getStart(), node });
    return;
  }
  ts.forEachChild(node, (child) => literalsUnder(child, out));
}

/**
 * Functions in the dictionary modules whose RETURN VALUE is words.
 *
 * `resolutionConfidence()` returns "verified" — the engine's own enum, and
 * exactly right there. `confidenceLabel()` returns "Confirmed" — words. Both are
 * a `return "<lowercase word>"` in the same file, and only the naming
 * distinguishes them, so the naming is what this reads. It is a convention this
 * repo already keeps; a display function that ignores it loses its coverage,
 * which is the trade for a report that is all signal.
 */
const DISPLAY_FN = /label|text|explain|describe|reason|title|word|summar|sentence|copy|format/i;
const BANNED_PUNCTUATION = /[—·•…‘’“”]|\.{3}|\s[|/]\s/;

function jsxTagName(node, sf) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(sf);
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(sf);
  return "";
}

function isInlineStrong(node, sf) {
  if (!ts.isJsxElement(node) || jsxTagName(node, sf).toLowerCase() !== "strong") return false;
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) {
      return /^(p|span|label|li|dd|dt)$/i.test(jsxTagName(p, sf));
    }
  }
  return false;
}

function enclosingFunctionName(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p))
      return p.name ? p.name.getText(sf) : "";
    if (ts.isVariableDeclaration(p) && p.initializer && ts.isArrowFunction(p.initializer))
      return p.name.getText(sf);
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const owner = p.parent;
      if (ts.isVariableDeclaration(owner)) return owner.name.getText(sf);
    }
  }
  return "";
}

function isCodeString(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
    if (ts.isVariableDeclaration(p)) {
      const name = p.name.getText(sf);
      return /(?:script|bootstrap|source|sql|query|pattern|regex)$/i.test(name);
    }
    if (ts.isJsxExpression(p) || ts.isReturnStatement(p) || ts.isCallExpression(p)) return false;
  }
  return false;
}

/**
 * @returns {{ text: string, line: number, column: number, context: string }[]}
 */
export function extractCopy(sourceText, fileName) {
  const isDictionary = DICTIONARY_FILES.some((f) => fileName.replaceAll("\\", "/").endsWith(f));
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const found = [];
  const renderedIdentifiers = new Set();
  const collectRenderedIdentifiers = (node) => {
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      !ts.isJsxAttribute(node.parent) &&
      ts.isIdentifier(node.expression)
    ) {
      renderedIdentifiers.add(node.expression.text);
    }
    ts.forEachChild(node, collectRenderedIdentifiers);
  };
  collectRenderedIdentifiers(sf);
  const push = (text, pos, context, node) => {
    if (!looksLikeCopy(text)) return;
    if (node && isValueNotCopy(node)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    found.push({ text, line: line + 1, column: character + 1, context });
  };
  const pushBannedPunctuation = (text, pos) => {
    if (!text.trim()) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    found.push({
      text,
      line: line + 1,
      column: character + 1,
      context: "banned punctuation",
    });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      // Collapse the newlines and indentation JSX inserts, so a rule that looks
      // at sentence shape sees the sentence rather than the source formatting.
      const text = node.text.replace(/\s+/g, " ").trim();
      if (text) push(text, node.getStart(), "jsx-text");
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sf);
      if (COPY_ATTRIBUTES.has(name)) {
        const lits = [];
        literalsUnder(node.initializer, lits);
        for (const l of lits) push(l.text, l.pos, `attribute ${name}`, l.node);
      }
    } else if (ts.isJsxExpression(node) && node.expression) {
      const lits = [];
      literalsUnder(node.expression, lits);
      for (const l of lits) push(l.text, l.pos, "jsx-expression", l.node);
    } else if (ts.isCallExpression(node) && COPY_CALLEES.has(calleeName(node))) {
      const lits = [];
      for (const arg of node.arguments) literalsUnder(arg, lits);
      for (const l of lits) push(l.text, l.pos, "toast", l.node);
    } else if (ts.isCallExpression(node) && RESPONSE_CALLEES.has(calleeName(node))) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = prop.name.getText(sf).replace(/["']/g, "");
          if (!RESPONSE_COPY_KEYS.has(key)) continue;
          const lits = [];
          literalsUnder(prop.initializer, lits);
          for (const l of lits) push(l.text, l.pos, `response ${key}`, l.node);
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      renderedIdentifiers.has(node.name.text) &&
      node.initializer
    ) {
      const lits = [];
      literalsUnder(node.initializer, lits);
      for (const l of lits) push(l.text, l.pos, `rendered variable ${node.name.text}`, l.node);
    } else if (isInlineStrong(node, sf)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      found.push({
        text: "<strong>",
        line: line + 1,
        column: character + 1,
        context: "inline bold markup",
      });
    } else if (ts.isReturnStatement(node) && node.expression) {
      if (DISPLAY_FN.test(enclosingFunctionName(node, sf))) {
        const lits = [];
        literalsUnder(node.expression, lits);
        for (const l of lits) push(l.text, l.pos, "dictionary return", l.node);
      }
    } else if (isDictionary && ts.isVariableDeclaration(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (/label|text|copy|word|title|noun|reason|message/i.test(name)) {
        const lits = [];
        literalsUnder(node.initializer, lits);
        for (const l of lits) push(l.text, l.pos, `dictionary const ${name}`, l.node);
      }
    } else if (isDictionary && ts.isPropertyAssignment(node)) {
      const key = node.name.getText(sf).replace(/["']/g, "");
      if (/^(label|header|text|title|name|note|hint|body|placeholder)$/i.test(key)) {
        const lits = [];
        literalsUnder(node.initializer, lits);
        for (const l of lits) push(l.text, l.pos, `dictionary property ${key}`, l.node);
      }
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      // These glyphs are banned everywhere copy can land. Follow the literal
      // itself rather than trying to infer the data flow through a local
      // variable: `const note = "· sorted"; return <span>{note}</span>` is
      // user-facing even though the JSX expression contains only an identifier.
      const lits = [];
      literalsUnder(node, lits);
      for (const l of lits)
        if (BANNED_PUNCTUATION.test(l.text) && !isCodeString(l.node, sf))
          pushBannedPunctuation(l.text, l.pos);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}
