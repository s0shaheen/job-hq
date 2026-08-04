/**
 * What route does a cited test actually drive?
 *
 * `spec-titles.ts` proves a citation names a test that EXISTS. That is a
 * weaker claim than the ledger makes. A cell says "this surface is covered in
 * this state", and until this module existed nothing stopped a cell on
 * `/companies` from being closed by a test that only ever loads `/queue`: the
 * title resolved, the gate went green, and the surface was never rendered. It
 * is not a hypothetical — two agents closed cells on 2026-08-02 while asserting
 * BY HAND that every citation drove the right route, which is the shape of rule
 * this repo has repeatedly watched break (`CLAUDE.md`, "What gets enforced by a
 * machine").
 *
 * So: a citation is rejected unless the cited test demonstrably navigates a
 * route the cited surface owns.
 *
 * ─────────────────────────────────────────────────────────── why static
 *
 * Three ways to establish "demonstrably", and the choice matters more than the
 * code:
 *
 * 1. STATIC (this file). Parse the spec, resolve what it passes to `goto`,
 *    compare against the surface's routes.
 * 2. DYNAMIC. Have Playwright record every main-frame navigation per test and
 *    check citations against the recording.
 * 3. HYBRID: static, with a recorded record filling the gaps.
 *
 * Dynamic is truthful by construction and it is the one I did not take, for
 * three reasons that are properties of THIS repo rather than opinions:
 *
 *   - The record has to be committed to be usable, because the gate runs on CI
 *     shard 1 next to `lint:copy` and locally in about a second, both without a
 *     browser. A committed record is a hand-editable file. That moves the
 *     laundering one file sideways — from "cite a test that does not drive the
 *     surface" to "add a line to the JSON" — and this task exists precisely
 *     because a check that a person performs is not a check.
 *   - Playwright runs `--shard=N/2` in CI, so no single job ever observes the
 *     whole suite. A record assembled from one shard is missing half the tests
 *     and cannot tell "never navigated there" from "ran on the other shard".
 *     This one is fatal on its own, independently of the objection above: even
 *     a record nobody could hand-edit would still be half a record, and a
 *     coverage gate that reads "no evidence" as "no coverage" would red every
 *     citation on the other shard. Merging shards before checking only moves
 *     the problem to "which shards have reported", which is a scheduling fact,
 *     not a coverage one. It is also the reason nobody would rediscover, since
 *     the sharding lives in a workflow file and not in the gate.
 *   - `17-ui-verification-standard.md` §9 requires flaky tests to be
 *     QUARANTINED rather than deleted. A quarantined (skipped) test emits no
 *     navigations, so a dynamic gate must either red the build for a test the
 *     flake policy deliberately parked, or exempt skips — a silent hole exactly
 *     where the estate is least trustworthy.
 *
 * What static would miss, and what is done about it: indirection. This estate
 * is full of it — module-level path arrays swept in a loop (`layout.spec.ts`,
 * `resilience.spec.ts`), local helpers that take the route as a parameter
 * (`entry-path.spec.ts` `refusedAt`, `apply.spec.ts` `gotoApply`), template
 * literals (`/apply/${id}`), and genuinely undecidable URLs read back out of
 * the running page (`import-wizard.spec.ts` navigates to a batch id minted at
 * upload time; `routing.spec.ts` follows an href scraped from the DOM). A
 * regex over `goto("…")` sees none of that and would have to treat what it
 * cannot read as a pass, which is the vacuous gate again.
 *
 * The answer is not cleverness, it is the direction of the failure. The
 * resolver below understands constants, arrays, object literals, `for…of`
 * bindings, template prefixes and parameter binding across local helper calls,
 * and everything it still cannot read is recorded as UNRESOLVED and reported
 * as an error naming the expression and its line. Indirection reddens the gate;
 * it never greens it. Where a route is truly only knowable at runtime, the
 * citation says so in writing, per citation, with a reason (`drives`/`why` in
 * `spec-titles.ts`) — an escape hatch that is visible in the diff and rendered
 * into the evidence file, never a silent skip.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import ts from "typescript";
import { WEBAPP_ROOT } from "./sources";

/** One navigation the extractor could read. */
export interface ResolvedNav {
  readonly route: string;
  readonly line: number;
}

/** One navigation it could not. Never treated as a pass. */
export interface UnresolvedNav {
  readonly expression: string;
  readonly line: number;
}

export interface Navigations {
  readonly routes: readonly string[];
  readonly unresolved: readonly UnresolvedNav[];
  /**
   * The cited test's own source, plus every hook and local helper that runs
   * for it. `states.ts` reads it to ask the second question: the route proof
   * says the test loaded the surface, this says whether it ever put the
   * surface into the state the cell claims.
   */
  readonly text: string;
}

interface Sink {
  navs: ResolvedNav[];
  unresolved: UnresolvedNav[];
  calls: Call[];
  /** Source text, for the state fingerprints in `states.ts`. */
  text: string;
}

/** A `test(…)` or `test.describe(…)` node with what it navigates. */
interface Unit extends Sink {
  readonly title: string;
  readonly kind: "test" | "describe";
  /** Index into the flat unit list of the enclosing describe, or -1. */
  readonly parent: number;
  /** `""` for a plain `test(…)`; otherwise `skip`, `fixme`, `fail`, `only`. */
  readonly modifier: string;
  readonly line: number;
}

/** How a cited test is DECLARED — the part of "does it pass" a parser can see. */
export interface Declaration {
  /** The modifier on the test itself, or inherited from a describe. */
  readonly modifier: string;
  /** Where it is, for the error message. */
  readonly line: number;
  /** Set when the modifier is inherited rather than on the test itself. */
  readonly from?: string;
}

interface Call {
  readonly name: string;
  readonly args: readonly ValueSet[];
  readonly line: number;
}

/**
 * What an expression can be. `unknown` is a first-class outcome, not a bug:
 * the whole point is that "I could not read this" propagates instead of
 * evaporating.
 */
type ValueSet =
  | { readonly kind: "strings"; readonly values: readonly string[] }
  | { readonly kind: "objects"; readonly values: readonly Map<string, ValueSet>[] }
  | { readonly kind: "unknown"; readonly text: string };

const UNKNOWN = (text: string): ValueSet => ({ kind: "unknown", text });
const STRINGS = (values: readonly string[]): ValueSet => ({ kind: "strings", values });

function emptySink(): Sink {
  return { navs: [], unresolved: [], calls: [], text: "" };
}

/** A file-local function that may navigate, resolved lazily per call site. */
interface Helper {
  readonly name: string;
  readonly params: readonly { readonly name: string; readonly fallback: ValueSet | null }[];
  readonly body: ts.Node;
}

/** Every navigation-relevant fact about one spec file. */
export class SpecRoutes {
  private readonly source: ts.SourceFile;
  private readonly units: Unit[] = [];
  private readonly helpers = new Map<string, Helper>();
  private readonly moduleScope = new Map<string, ValueSet>();
  /** Hooks not inside any describe apply to every test in the file. */
  private readonly fileHooks: Sink = emptySink();
  /** Hooks inside describe N apply to every test under it. */
  private readonly describeHooks = new Map<number, Sink>();

  /** `SETTINGS_SECTIONS` -> `../../app/(app)/settings/sections`. */
  private readonly imports = new Map<string, string>();

  constructor(
    readonly specPath: string,
    text: string,
    private readonly root: string = WEBAPP_ROOT,
  ) {
    this.source = ts.createSourceFile(specPath, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    this.collectImports();
    this.collectModuleScope();
    this.walk(this.source, -1, this.moduleScope);
  }

  private collectImports(): void {
    for (const stmt of this.source.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const from = stmt.moduleSpecifier.text;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) this.imports.set(el.name.text, from);
      }
    }
  }

  /**
   * Resolve a constant this spec IMPORTED.
   *
   * `settings.spec.ts` sweeps `SETTINGS_SECTIONS` — the app's own section
   * registry — rather than a path list copied into the test. That is better
   * practice than a hardcoded array, because the test cannot drift from the
   * nav, and a route proof that could not read it would push authors toward
   * the worse pattern to keep the gate quiet. So the extractor follows the
   * import.
   *
   * Only file-local reasoning, one module deep: enough for a registry of
   * literals, and it stops well short of being a module resolver.
   */
  private importedValue(name: string): ValueSet | null {
    const from = this.imports.get(name);
    if (from === null || from === undefined) return null;
    const base = from.startsWith("@/")
      ? resolvePath(this.root, from.slice(2))
      : from.startsWith(".")
        ? resolvePath(this.root, dirname(this.specPath), from)
        : null;
    if (base === null) return null; // a package, not this repo's source

    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      let text: string;
      try {
        text = readFileSync(candidate, "utf8");
      } catch {
        continue;
      }
      const module = ts.createSourceFile(candidate, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
      const scope = new Map<string, ValueSet>();
      // Two passes: a registry often refers to constants declared above it.
      for (const pass of [0, 1]) {
        void pass;
        for (const stmt of module.statements) {
          if (!ts.isVariableStatement(stmt)) continue;
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer) {
              scope.set(decl.name.text, this.evaluate(decl.initializer, scope));
            }
          }
        }
      }
      const found = scope.get(name);
      if (found && found.kind !== "unknown") return found;
    }
    return null;
  }

  private line(node: ts.Node): number {
    return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
  }

  // ─────────────────────────────────────────────────── module-level bindings

  private collectModuleScope(): void {
    for (const stmt of this.source.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const init = decl.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            this.helpers.set(decl.name.text, {
              name: decl.name.text,
              params: this.params(init.parameters),
              body: init.body,
            });
            continue;
          }
          this.moduleScope.set(decl.name.text, this.evaluate(init, this.moduleScope));
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        this.helpers.set(stmt.name.text, {
          name: stmt.name.text,
          params: this.params(stmt.parameters),
          body: stmt.body,
        });
      }
    }
  }

  /**
   * Parameter names plus their DEFAULTS. `gotoJobs(page, path = "/jobs")` is
   * called bare almost everywhere in `grid-selection.spec.ts`; without the
   * default the route is unreadable and eleven honest citations would have
   * needed an escape hatch apiece.
   */
  private params(
    list: readonly ts.ParameterDeclaration[],
  ): { name: string; fallback: ValueSet | null }[] {
    return list.map((p) => ({
      name: ts.isIdentifier(p.name) ? p.name.text : "",
      fallback: p.initializer ? this.evaluate(p.initializer, this.moduleScope) : null,
    }));
  }

  // ─────────────────────────────────────────────────────────── expressions

  private evaluate(node: ts.Expression, scope: Map<string, ValueSet>): ValueSet {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return STRINGS([node.text]);
    }
    if (ts.isTemplateExpression(node)) {
      // `${PERF_URL}&set=all` and `/apply/${id}` are both useful: the first
      // resolves through an empty head and a known first span, the second
      // through a literal head. A route matches by path segments, so a literal
      // prefix names the surface — and an EMPTY prefix does not, which is why
      // that case falls through to the interpolated value.
      const head = node.head.text;
      if (head.startsWith("/")) {
        // `/apply/${id}` names a DYNAMIC SEGMENT, not the literal `/apply/`.
        // Dropping the interpolation left `/apply/`, which normalises to
        // `/apply` and then failed to match `/apply/[applicationId]` on
        // segment count — a true citation rejected for the wrong reason. The
        // placeholder segment says "one segment, contents unknown", which is
        // exactly what a Next dynamic route accepts.
        return STRINGS([head.endsWith("/") ? `${head}[interpolated]` : head]);
      }
      if (head === "" && node.templateSpans.length > 0) {
        const first = this.evaluate(node.templateSpans[0].expression, scope);
        if (first.kind === "strings") return first;
      }
      return UNKNOWN(node.getText(this.source));
    }
    if (ts.isIdentifier(node)) {
      const local = scope.get(node.text);
      if (local) return local;
      return this.importedValue(node.text) ?? UNKNOWN(node.text);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const strings: string[] = [];
      const objects: Map<string, ValueSet>[] = [];
      for (const el of node.elements) {
        const v = ts.isSpreadElement(el) ? this.evaluate(el.expression, scope) : this.evaluate(el, scope);
        if (v.kind === "strings") strings.push(...v.values);
        else if (v.kind === "objects") objects.push(...v.values);
        else return UNKNOWN(node.getText(this.source));
      }
      if (objects.length > 0 && strings.length === 0) return { kind: "objects", values: objects };
      if (objects.length === 0) return STRINGS(strings);
      return UNKNOWN(node.getText(this.source));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const map = new Map<string, ValueSet>();
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
          map.set(prop.name.text, this.evaluate(prop.initializer, scope));
        }
      }
      return { kind: "objects", values: [map] };
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = this.evaluate(node.expression, scope);
      if (target.kind === "objects") {
        const values: string[] = [];
        for (const obj of target.values) {
          const v = obj.get(node.name.text);
          if (v?.kind === "strings") values.push(...v.values);
          else return UNKNOWN(node.getText(this.source));
        }
        return STRINGS(values);
      }
      return UNKNOWN(node.getText(this.source));
    }
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
      return this.evaluate(node.expression, scope);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      // `PREFIX + something`: the prefix is what names the route.
      const left = this.evaluate(node.left, scope);
      if (left.kind === "strings" && left.values.every((v) => v.startsWith("/"))) return left;
      return UNKNOWN(node.getText(this.source));
    }
    return UNKNOWN(node.getText(this.source));
  }

  // ───────────────────────────────────────────────────────────── the walk

  private isNavigation(node: ts.CallExpression): boolean {
    const callee = node.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === "goto";
  }

  /** `test(…)`, `test.describe(…)`, `test.beforeEach(…)`, … */
  private testCall(node: ts.CallExpression): string | null {
    let callee = node.expression;
    const parts: string[] = [];
    while (ts.isPropertyAccessExpression(callee)) {
      parts.unshift(callee.name.text);
      callee = callee.expression;
    }
    if (!ts.isIdentifier(callee) || callee.text !== "test") return null;
    return parts.join(".");
  }

  private hookSink(unitIndex: number): Sink {
    if (unitIndex < 0) return this.fileHooks;
    let sink = this.describeHooks.get(unitIndex);
    if (!sink) {
      sink = emptySink();
      this.describeHooks.set(unitIndex, sink);
    }
    return sink;
  }

  private walk(node: ts.Node, unitIndex: number, scope: Map<string, ValueSet>): void {
    if (ts.isCallExpression(node)) {
      const suffix = this.testCall(node);
      if (suffix !== null) {
        if (suffix.startsWith("beforeEach") || suffix.startsWith("beforeAll")) {
          const sink = this.hookSink(unitIndex);
          sink.text += node.getText(this.source);
          for (const arg of node.arguments) this.walkInto(arg, sink, scope);
          return;
        }
        const isDescribe = suffix.startsWith("describe");
        const isTest = suffix === "" || ["skip", "fixme", "only", "fail", "slow"].includes(suffix);
        if (isDescribe || isTest) {
          const titleArg = node.arguments[0];
          const title = titleArg ? this.evaluate(titleArg, scope) : UNKNOWN("");
          // A computed title cannot be cited (`spec-titles.ts` collects
          // literals only), but its BODY still belongs to the enclosing
          // describe — which is how `layout.spec.ts` earns its citation: the
          // citable name is the describe, and every route lives inside a
          // generated `${path} @ ${width}px` test.
          const literal = title.kind === "strings" && title.values.length === 1 ? title.values[0] : "";
          const index = this.units.length;
          this.units.push({
            title: literal,
            kind: isDescribe ? "describe" : "test",
            parent: unitIndex,
            // `test.skip("title", fn)` is a QUARANTINE. `test.skip(cond, why)`
            // inside a body is a project filter and is not a declaration at
            // all, which is why this reads the modifier only where a literal
            // title sits in the first argument.
            modifier: literal ? suffix.replace(/^describe\.?/, "") : "",
            line: this.line(node),
            ...emptySink(),
          });
          this.units[index].text = node.getText(this.source);
          for (let i = 1; i < node.arguments.length; i += 1) {
            this.walkBody(node.arguments[i], index, scope);
          }
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => this.walk(child, unitIndex, scope));
  }

  /** Body of a test/describe: collect its own navs, and recurse for nesting. */
  private walkBody(node: ts.Node, unitIndex: number, scope: Map<string, ValueSet>): void {
    const unit = this.units[unitIndex];
    const visit = (n: ts.Node, s: Map<string, ValueSet>): void => {
      if (ts.isCallExpression(n) && this.testCall(n) !== null) {
        this.walk(n, unitIndex, s);
        return;
      }
      if (ts.isCallExpression(n)) this.record(n, unit, s);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        s.set(n.name.text, this.evaluate(n.initializer, s));
      }
      if (ts.isForOfStatement(n)) {
        this.visitForOf(n, s, (child, inner) => visit(child, inner));
        return;
      }
      ts.forEachChild(n, (child) => visit(child, s));
    };
    visit(node, new Map(scope));
  }

  /** Bind a `for (const x of LITERALS)` / `for (const { path } of ROWS)` head. */
  private visitForOf(
    n: ts.ForOfStatement,
    s: Map<string, ValueSet>,
    recurse: (child: ts.Node, inner: Map<string, ValueSet>) => void,
  ): void {
    const over = this.evaluate(n.expression, s);
    const inner = new Map(s);
    const decl = ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0] : null;
    if (decl && ts.isIdentifier(decl.name)) {
      inner.set(decl.name.text, over);
    } else if (decl && ts.isObjectBindingPattern(decl.name) && over.kind === "objects") {
      for (const el of decl.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        const values: string[] = [];
        let ok = true;
        for (const obj of over.values) {
          const v = obj.get(key);
          if (v?.kind === "strings") values.push(...v.values);
          else ok = false;
        }
        inner.set(el.name.text, ok ? STRINGS(values) : UNKNOWN(el.name.text));
      }
    }
    recurse(n.statement, inner);
  }

  /** Same as walkBody, but for a hook or helper body, which owns no unit. */
  private walkInto(node: ts.Node, sink: Sink, scope: Map<string, ValueSet>): void {
    const pseudo: Unit = { title: "", kind: "test", parent: -1, modifier: "", line: 0, ...sink };
    // Share the arrays, not copies.
    pseudo.navs = sink.navs;
    pseudo.unresolved = sink.unresolved;
    pseudo.calls = sink.calls;
    const visit = (n: ts.Node, s: Map<string, ValueSet>): void => {
      if (ts.isCallExpression(n)) this.record(n, pseudo, s);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        s.set(n.name.text, this.evaluate(n.initializer, s));
      }
      if (ts.isForOfStatement(n)) {
        this.visitForOf(n, s, (child, i) => visit(child, i));
        return;
      }
      ts.forEachChild(n, (child) => visit(child, s));
    };
    visit(node, new Map(scope));
  }

  /**
   * `await expect(page).toHaveURL(…)` is navigation evidence too, and better
   * evidence than the `goto` that preceded it: it asserts where the browser
   * ENDED UP. `entry-path.spec.ts` is built on exactly this shape — every
   * refusal asks for some product route and asserts it landed on `/pending`,
   * which is the route the settings-auth-onboarding surface owns. Reading only
   * `goto` credited those tests with `/queue` and rejected six true citations.
   *
   * Ignored unless the pattern names a literal path, so a regex over a
   * captured value proves nothing and stays unresolved.
   */
  private landingRoutes(n: ts.CallExpression, scope: Map<string, ValueSet>): string[] {
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "toHaveURL") return [];
    const arg = n.arguments[0];
    if (!arg) return [];
    const pattern = this.regexSource(arg, scope);
    if (pattern === null) return [];
    // `/\/queue$/` and `new RegExp(`${HOLDING}$`)` both reduce to a path.
    const path = pattern.replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "");
    return path.startsWith("/") && !/[*+?()[\]|\\]/.test(path) ? [path] : [];
  }

  private regexSource(node: ts.Expression, scope: Map<string, ValueSet>): string | null {
    if (ts.isRegularExpressionLiteral(node)) {
      const text = node.getText(this.source);
      const end = text.lastIndexOf("/");
      return text.slice(1, end);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      const first = node.arguments?.[0];
      if (!first) return null;
      const value = this.evaluate(first, scope);
      return value.kind === "strings" && value.values.length === 1 ? value.values[0] : null;
    }
    const value = this.evaluate(node, scope);
    return value.kind === "strings" && value.values.length === 1 ? value.values[0] : null;
  }

  /** Record a `goto`, a landing assertion, or a call to a file-local helper. */
  private record(n: ts.CallExpression, unit: Unit, scope: Map<string, ValueSet>): void {
    for (const route of this.landingRoutes(n, scope)) {
      unit.navs.push({ route, line: this.line(n) });
    }
    if (this.isNavigation(n)) {
      const arg = n.arguments[0];
      const line = this.line(n);
      if (!arg) {
        unit.unresolved.push({ expression: "goto()", line });
        return;
      }
      const value = this.evaluate(arg, scope);
      if (value.kind === "strings" && value.values.length > 0) {
        for (const route of value.values) unit.navs.push({ route, line });
      } else {
        unit.unresolved.push({
          expression: arg.getText(this.source).replace(/\s+/g, " ").slice(0, 60),
          line,
        });
      }
      return;
    }
    const callee = n.expression;
    const name = ts.isIdentifier(callee) ? callee.text : null;
    if (name && this.helpers.has(name)) {
      unit.calls.push({ name, args: n.arguments.map((a) => this.evaluate(a, scope)), line: this.line(n) });
    }
  }

  // ─────────────────────────────────────────────────── helper resolution

  private helperCache = new Map<string, Navigations>();

  private navsOfHelper(call: Call, seen: Set<string>): Navigations {
    const helper = this.helpers.get(call.name);
    if (!helper) return { routes: [], unresolved: [], text: "" };
    const key = `${call.name}(${call.args
      .map((a) => (a.kind === "strings" ? a.values.join(",") : a.kind))
      .join("|")})`;
    const cached = this.helperCache.get(key);
    if (cached) return cached;
    if (seen.has(call.name)) return { routes: [], unresolved: [], text: "" };
    seen.add(call.name);

    const scope = new Map(this.moduleScope);
    helper.params.forEach((p, i) => {
      if (!p.name) return;
      scope.set(p.name, call.args[i] ?? p.fallback ?? UNKNOWN(p.name));
    });

    const sink = emptySink();
    this.walkInto(helper.body, sink, scope);
    const routes = sink.navs.map((nav) => nav.route);
    const unresolved = [...sink.unresolved];
    let text = helper.body.getText(this.source);
    for (const nested of sink.calls) {
      const inner = this.navsOfHelper(nested, seen);
      routes.push(...inner.routes);
      unresolved.push(...inner.unresolved);
      text += inner.text;
    }
    seen.delete(call.name);
    const out: Navigations = { routes, unresolved, text };
    this.helperCache.set(key, out);
    return out;
  }

  // ────────────────────────────────────────────────────────── public API

  /**
   * How the cited unit is declared, including a modifier inherited from an
   * enclosing describe. `states.ts` uses it for the one part of "does this
   * test pass" that is knowable without running it: whether it runs at all.
   */
  declaration(title: string): Declaration | null {
    const index = this.units.findIndex((u) => u.title === title);
    if (index < 0) return null;
    const unit = this.units[index];
    if (["skip", "fixme", "fail", "only"].includes(unit.modifier)) {
      return { modifier: unit.modifier, line: unit.line };
    }
    let parent = unit.parent;
    while (parent >= 0) {
      const ancestor = this.units[parent];
      if (["skip", "fixme", "fail", "only"].includes(ancestor.modifier)) {
        return { modifier: ancestor.modifier, line: ancestor.line, from: ancestor.title };
      }
      parent = ancestor.parent;
    }
    return { modifier: "", line: unit.line };
  }

  /**
   * Every route the named unit drives, plus what could not be read.
   *
   * A citation may name a `test` or a `test.describe`. For a describe the
   * answer is the union over everything under it: `layout.spec.ts` names the
   * sweep once and generates a test per path per width, so the citable name is
   * the describe. Hooks count too — a `beforeEach` that navigates is
   * navigation, and an ancestor hook runs for the cited unit as well.
   */
  navigations(title: string): Navigations | null {
    const rootIndexes = this.units.map((u, i) => (u.title === title ? i : -1)).filter((i) => i >= 0);
    if (rootIndexes.length === 0) return null;

    const routes: string[] = [];
    const unresolved: UnresolvedNav[] = [];
    const texts: string[] = [];
    const absorbed = new Set<Sink>();

    const absorb = (sink: Sink): void => {
      if (absorbed.has(sink)) return;
      absorbed.add(sink);
      routes.push(...sink.navs.map((nav) => nav.route));
      unresolved.push(...sink.unresolved);
      texts.push(sink.text);
      for (const call of sink.calls) {
        const inner = this.navsOfHelper(call, new Set());
        routes.push(...inner.routes);
        unresolved.push(...inner.unresolved);
        texts.push(inner.text);
      }
    };

    const descend = (index: number): void => {
      absorb(this.units[index]);
      const hooks = this.describeHooks.get(index);
      if (hooks) absorb(hooks);
      this.units.forEach((u, i) => {
        if (u.parent === index) descend(i);
      });
    };

    for (const root of rootIndexes) {
      descend(root);
      // Ancestor hooks: a beforeEach above the cited unit runs for it too.
      let parent = this.units[root].parent;
      while (parent >= 0) {
        const hooks = this.describeHooks.get(parent);
        if (hooks) absorb(hooks);
        parent = this.units[parent].parent;
      }
    }
    absorb(this.fileHooks);

    return { routes: [...new Set(routes)], unresolved, text: texts.join("\n") };
  }
}

/** Parses each spec once per run. */
export class RouteExtractor {
  private cache = new Map<string, SpecRoutes | null>();

  constructor(private readonly root: string = WEBAPP_ROOT) {}

  spec(path: string): SpecRoutes | null {
    if (!this.cache.has(path)) {
      let text: string | null = null;
      try {
        text = readFileSync(resolvePath(this.root, path), "utf8");
      } catch {
        text = null;
      }
      this.cache.set(path, text === null ? null : new SpecRoutes(path, text, this.root));
    }
    return this.cache.get(path) ?? null;
  }
}

/**
 * Does a navigated URL land on a route the surface owns?
 *
 * Surface routes are Next paths, so `/apply/[applicationId]` matches
 * `/apply/1`. A query string or hash is not part of the route. `*` means the
 * surface renders inside every app route and has to say why in writing — see
 * `SurfaceLedger.routeProofNote`.
 */
export function routeMatches(navigated: string, surfaceRoute: string): boolean {
  const nav = normalize(navigated);
  if (surfaceRoute === "*") return nav.startsWith("/");
  const want = normalize(surfaceRoute);
  if (nav === want) return true;
  const navParts = nav.split("/");
  const wantParts = want.split("/");
  const catchAll = wantParts.findIndex((p) => /^\[\.\.\..+\]$/.test(p));
  if (catchAll >= 0) {
    return (
      navParts.length > catchAll && wantParts.slice(0, catchAll).every((p, i) => segmentMatches(navParts[i], p))
    );
  }
  // `/auth/*` in the ledger is prose for "every route under /auth".
  if (wantParts[wantParts.length - 1] === "*") {
    const head = wantParts.slice(0, -1);
    return navParts.length > head.length && head.every((p, i) => segmentMatches(navParts[i], p));
  }
  if (navParts.length !== wantParts.length) return false;
  return wantParts.every((p, i) => segmentMatches(navParts[i], p));
}

function segmentMatches(nav: string | undefined, want: string): boolean {
  if (nav === undefined) return false;
  if (/^\[.+\]$/.test(want)) return nav.length > 0;
  return nav === want;
}

function normalize(route: string): string {
  let out = route.split("#")[0].split("?")[0];
  // An absolute URL can appear in a goto; only the path is a route.
  const scheme = out.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (scheme) out = scheme[1] ?? "/";
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
