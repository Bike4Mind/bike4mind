import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Static analysis behind `checkViMockSpecifierDrift.test.ts`.
 *
 * `vi.mock('<specifier>', factory)` intercepts by specifier, so a mock keeps compiling - and
 * keeps passing - after the symbol it stubs moves to a different subpath of the same package.
 * The real module loads instead, silently. Nothing else in the toolchain sees it: a factory is
 * an untyped object literal, so `tsc` never compares it against the module it replaces.
 *
 * The built `dist` artifact is the authority rather than `src`, because vitest resolves these
 * packages through their `exports` map (there is no `@bike4mind/*` path alias in any tsconfig),
 * and because that map and each package's `tsdown` entry list are hand-synced.
 */

/** What a built entry point exposes. */
export interface ExportSurface {
  /** Names the ESM artifact binds at runtime - the set a `vi.mock` factory key must land in. */
  values: Set<string>;
  /** `values` plus type-only names from the `.d.mts`. Stubbing one of those is dead weight, not drift. */
  known: Set<string>;
  /** A `export * from` target that could not be enumerated, so absence from `known` proves nothing. */
  open: boolean;
}

/** One built entry point of a workspace package, keyed by the specifier a consumer writes. */
export interface PackageEntry {
  /** Owning package, so a finding can name the sibling subpaths worth pointing at. */
  packageName: string;
  /** Absolute path of the ESM artifact, or null when the exports map points at something unbuilt. */
  runtime: string | null;
  /** Absolute path of the matching declaration file, when the package emits one. */
  types: string | null;
}

/** A `vi.mock`/`vi.doMock` call found in a test file. */
export interface MockCall {
  specifier: string;
  line: number;
  /**
   * Top-level keys of the object literal the factory returns, or null when the factory does not
   * return one statically (`() => someVariable`, `async () => actual`). Null stubs nothing this
   * analysis can name, so it is skipped rather than guessed at.
   */
  keys: string[] | null;
}

export interface DriftFinding {
  file: string;
  line: number;
  specifier: string;
  key: string;
  /** Sibling specifiers of the same package whose runtime artifact does export `key`. */
  exportedBy: string[];
}

/**
 * Line-anchored `export ...;` statements of a bundled artifact. tsdown emits one or two per entry,
 * at column 0 and semicolon-terminated, so slicing them out avoids parsing an 800KB bundle to read
 * a single statement. Brace-aware, so a multi-line `export { ... };` survives intact.
 *
 * Text-level, so a bundled string literal whose own content starts a line with `export {` would be
 * read as a statement. The backstop is the "can enumerate the exports of every entry point" case in
 * checkViMockSpecifierDrift.test.ts: a scan that breaks down shows up there as an unreadable entry
 * rather than as a wave of false positives across the tree.
 */
function exportStatements(text: string): string {
  const statements: string[] = [];
  const anchored = /^export[\s{*]/gm;
  for (let match = anchored.exec(text); match; match = anchored.exec(text)) {
    let depth = 0;
    for (let i = match.index; i < text.length; i++) {
      const char = text[i];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === ';' && depth === 0) {
        statements.push(text.slice(match.index, i + 1));
        break;
      }
    }
  }
  return statements.join('\n');
}

/** Named exports of one artifact, plus any `export * from` targets left for the caller to follow. */
function readExports(file: string): { names: Set<string>; stars: string[] } {
  const names = new Set<string>();
  const stars: string[] = [];
  const source = ts.createSourceFile(
    file,
    exportStatements(readFileSync(file, 'utf8')),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    ts.ScriptKind.JS
  );
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add('default');
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else if (!clause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        stars.push(statement.moduleSpecifier.text);
      }
    }
  }
  return { names, stars };
}

/**
 * Resolves each declared specifier to the surface of its built artifact, following `export * from`
 * re-export chains across workspace packages (`@bike4mind/services/utils/crypto` is a star
 * re-export of `@bike4mind/auth/crypto`, and `@bike4mind/database` of `@bike4mind/db-core`).
 */
export function createSurfaceResolver(entries: Map<string, PackageEntry>) {
  const cache = new Map<string, ExportSurface>();

  const collect = (file: string | null, into: Set<string>, visiting: Set<string>): boolean => {
    if (!file || !existsSync(file)) return true; // unenumerable: treat the set as open
    if (visiting.has(file)) return false;
    visiting.add(file);
    const { names, stars } = readExports(file);
    for (const name of names) into.add(name);
    let open = false;
    for (const star of stars) {
      const target = star.startsWith('.')
        ? path.resolve(path.dirname(file), star)
        : (entries.get(star)?.runtime ?? null);
      // A star re-export of a specifier this map does not own (a third-party package) leaves the
      // set incomplete, which would make every unmatched key a false positive.
      if (star.startsWith('.') || entries.has(star)) open = collect(target, into, visiting) || open;
      else open = true;
    }
    return open;
  };

  return function surfaceFor(specifier: string): ExportSurface | null {
    const cached = cache.get(specifier);
    if (cached) return cached;
    const entry = entries.get(specifier);
    if (!entry) return null;

    const values = new Set<string>();
    const openValues = collect(entry.runtime, values, new Set());
    const known = new Set(values);
    // Type-only names come from the declaration file: `export type X` has no runtime binding, so
    // stubbing it is inert rather than drifted, and flagging it would bury the real findings.
    const openTypes = entry.types ? collect(entry.types, known, new Set()) : false;

    const surface: ExportSurface = { values, known, open: openValues || openTypes };
    cache.set(specifier, surface);
    return surface;
  };
}

/** Reads a workspace package's `exports` map into one entry per declared specifier. */
export function readPackageEntries(packageDir: string): Map<string, PackageEntry> {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return new Map();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string;
    exports?: Record<string, unknown>;
  };
  if (!manifest.name || !manifest.exports) return new Map();

  const entries = new Map<string, PackageEntry>();
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    // Two condition shapes in this workspace: `{ import: { types, default }, require: {...} }` for
    // the dual-format core packages, and a flat `{ types, default }` for the ESM-only ones.
    const condition = (target ?? {}) as {
      import?: { default?: string; types?: string };
      default?: string;
      types?: string;
    };
    const runtime = typeof target === 'string' ? target : (condition.import?.default ?? condition.default);
    const types = typeof target === 'string' ? undefined : (condition.import?.types ?? condition.types);
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    const resolve = (rel: string | undefined) => (rel ? path.join(packageDir, rel) : null);
    entries.set(specifier, {
      packageName: manifest.name,
      // Only a built ESM artifact carries an enumerable export list; a package that exports raw
      // `.ts` (e.g. @bike4mind/scripts) is left unresolved and its mocks go unchecked.
      runtime: runtime?.endsWith('.mjs') ? resolve(runtime) : null,
      types: types?.endsWith('.d.mts') ? resolve(types) : null,
    });
  }
  return entries;
}

/** Top-level keys of an object literal. Spreads and computed keys name nothing static. */
function literalKeys(literal: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const property of literal.properties) {
    const name = property.name;
    if (!name) continue; // a spread carries no key of its own
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.push(name.text);
  }
  return keys;
}

/** Unwraps the parentheses/`await`/`as` a factory may wrap its returned literal in. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The object literal a mock factory returns, or null when it does not return one statically. */
function factoryLiteral(factory: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!factory || (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))) return null;
  if (!ts.isBlock(factory.body)) {
    const body = unwrap(factory.body);
    return ts.isObjectLiteralExpression(body) ? body : null;
  }

  let found: ts.ObjectLiteralExpression | null = null;
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      const returned = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(returned)) found = returned;
    }
    // Do not descend into a nested scope: an object method's own `return { ... }` is not the
    // factory's return, and reading it would attribute that inner object's keys to the module.
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    node.forEachChild(walk);
  };
  factory.body.forEachChild(walk);
  return found;
}

/** Every `vi.mock`/`vi.doMock` call in a source file whose first argument is a literal specifier. */
export function collectMockCalls(sourceText: string, fileName: string): MockCall[] {
  if (!sourceText.includes('vi.mock') && !sourceText.includes('vi.doMock')) return [];
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const calls: MockCall[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      (node.expression.name.text === 'mock' || node.expression.name.text === 'doMock')
    ) {
      const specifier = node.arguments[0];
      if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        const literal = factoryLiteral(node.arguments[1]);
        calls.push({
          specifier: specifier.text,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          keys: literal ? literalKeys(literal) : null,
        });
      }
    }
    node.forEachChild(walk);
  };
  source.forEachChild(walk);
  return calls;
}

export interface AnalysisResult {
  findings: DriftFinding[];
  /** Mock calls actually compared against an export surface - the guard's non-vacuity floor. */
  checked: number;
  /** Calls skipped because the factory returns no static object literal. */
  unanalyzable: string[];
  /**
   * Mocks on a specifier a guarded package owns but no longer declares. The bluntest form of the
   * same drift: a renamed subpath makes the old specifier unresolvable, so the mock stubs nothing.
   */
  undeclared: string[];
}

/** Compares every mock call in `files` against the export surface of the specifier it targets. */
export function analyzeMockDrift(
  files: { path: string; text: string }[],
  entries: Map<string, PackageEntry>
): AnalysisResult {
  const surfaceFor = createSurfaceResolver(entries);
  const owners = new Set([...entries.values()].map(entry => entry.packageName));
  const findings: DriftFinding[] = [];
  const unanalyzable: string[] = [];
  const undeclared: string[] = [];
  let checked = 0;

  for (const file of files) {
    for (const call of collectMockCalls(file.text, file.path)) {
      const entry = entries.get(call.specifier);
      if (!entry) {
        const owner = [...owners].find(name => call.specifier === name || call.specifier.startsWith(`${name}/`));
        // Unowned specifiers are the common case (relative paths, third-party, path aliases).
        if (owner) undeclared.push(`${file.path}:${call.line} ${call.specifier}`);
        continue;
      }
      if (call.keys === null) {
        unanalyzable.push(`${file.path}:${call.line} ${call.specifier}`);
        continue;
      }
      const surface = surfaceFor(call.specifier);
      if (!surface || surface.open) continue;
      checked++;

      for (const key of call.keys) {
        if (surface.known.has(key)) continue;
        const exportedBy = [...entries]
          .filter(([specifier, sibling]) => {
            if (sibling.packageName !== entry.packageName || specifier === call.specifier) return false;
            return surfaceFor(specifier)?.values.has(key) ?? false;
          })
          .map(([specifier]) => specifier)
          .sort();
        findings.push({ file: file.path, line: call.line, specifier: call.specifier, key, exportedBy });
      }
    }
  }

  return { findings, checked, unanalyzable, undeclared };
}

/** One finding, formatted so the fix is a specifier edit rather than a hunt. */
export function formatFinding(finding: DriftFinding): string {
  const where = finding.exportedBy.length
    ? `exported by ${finding.exportedBy.join(', ')}`
    : 'exported by no declared entry point of that package - the stub is dead';
  return (
    `${finding.file}:${finding.line}\n` +
    `    vi.mock('${finding.specifier}') stubs '${finding.key}', which that specifier does not export\n` +
    `    -> ${where}`
  );
}
