import { REACT_BLESSED_SCRIPT_PATHS, PUBLISH_REACT_DEP_SCRIPTS } from '@bike4mind/common';
import { checkHasDefaultExport } from '@client/app/utils/artifactParser';
import { scanImportStatements, type ImportStatement } from '@client/app/utils/importStatements';
import { LUCIDE_WRAPPER_FN } from '@client/app/utils/reactArtifactDeps';
import { PUBLISH_HOST } from './validateBundle';

/**
 * Publish-time React transpiler (issue #21): converts a single-file React/JSX artifact into a
 * self-contained, INERT, eval-free HTML bundle the existing publisher can serve unchanged.
 *
 * This is the SERVER-SIDE counterpart of the in-app render at
 * `apps/client/pages/api/react-artifact-sandbox.ts` (inert mode): same import-rewrite +
 * default-export unwrap + hook-injection steps, and the same transpiler (`@babel/standalone`,
 * classic runtime) - but the JSX->`React.createElement` step runs once here at publish instead of
 * in the browser, so the published bundle matches the chat preview. The emitted
 * bundle uses only an inline `<script>` (no eval/new Function/document.write/string timers) plus
 * blessed `<script src>` for the React runtime, so it passes `validateBundle` and renders on the
 * isolated serve origin (whose CSP is `script-src 'unsafe-inline' 'self' <blessed>`).
 *
 * Scope: SINGLE-FILE artifacts only (multi-file is rejected up front, matching the sandbox).
 */

/**
 * Dependencies whose PUBLISH story exists. `react` is the base runtime (react-dom + prop-types
 * load alongside it); the optional deps (recharts, lucide-react, d3, lodash, mathjs, papaparse,
 * xlsx) are the self-hosted + blessed UMDs in PUBLISH_REACT_DEP_SCRIPTS. Importing anything else
 * fails with UnsupportedReactDependencyError so the publish is rejected cleanly rather than
 * producing a broken page.
 */
export const PUBLISH_SUPPORTED_DEPENDENCIES: readonly string[] = ['react', ...Object.keys(PUBLISH_REACT_DEP_SCRIPTS)];

/** Thrown when the artifact imports a dependency that is not yet publishable. */
export class UnsupportedReactDependencyError extends Error {
  readonly dependency: string;
  constructor(dependency: string) {
    super(
      `Dependency "${dependency}" is not publishable yet. Supported for publish: ${PUBLISH_SUPPORTED_DEPENDENCIES.join(
        ', '
      )}.`
    );
    this.name = 'UnsupportedReactDependencyError';
    this.dependency = dependency;
  }
}

/** Thrown when the source is multi-file, has no default export, or fails to transpile. */
export class ReactArtifactTranspileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReactArtifactTranspileError';
  }
}

// @babel/standalone is imported DYNAMICALLY (cached) so it loads only when a React artifact is
// actually published - not for every importer of the publish barrel. Unlike esbuild-wasm it has NO
// persistent service/worker/wasm: it is pure JS and `Babel.transform` is a stateless call, so it
// survives the Lambda freeze/thaw between invocations. (esbuild-wasm's cached service dies on thaw,
// throwing "The service was stopped" on the next warm publish.)
let babelPromise: Promise<typeof import('@babel/standalone')> | null = null;
function getBabel(): Promise<typeof import('@babel/standalone')> {
  if (!babelPromise) {
    babelPromise = import('@babel/standalone').catch(err => {
      babelPromise = null;
      throw err;
    });
  }
  return babelPromise;
}

const WS = /\s/;
const WORD = /\w/;

// Any relative reference (import/export-from, side-effect import, require) points at a sibling
// file the single-file bundle can't resolve - reject like the in-app sandbox does. The match set
// belongs to the sandbox preview (apps/client/pages/api/react-artifact-sandbox.ts), which still
// ships these three patterns to the browser and must keep finding exactly what this file finds:
//   /(?:import|export)\b[^;'"]*\bfrom\s*['"](\.\.?\/[^'"]+)['"]/  -> findRelativeImportFrom below
//   /\bimport\s*['"](\.\.?\/[^'"]+)['"]/                          -> RELATIVE_SIDE_EFFECT_IMPORT
//   /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/                  -> RELATIVE_REQUIRE
// Only the first was super-linear. The other two stay regexes: a start position can only reach the
// one quote adjacent to it, so their backtracking runs are disjoint and total work is linear
// (measured flat under a millisecond at 32k keywords, where the first pattern took 3.1s).
const RELATIVE_SIDE_EFFECT_IMPORT = /\bimport\s*['"](\.\.?\/[^'"]+)['"]/;
const RELATIVE_REQUIRE = /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/;

/** `['"](\.\.?\/[^'"]+)['"]` anchored at `quoteAt`: a quote, `./` or `../`, then a non-empty run
 *  to the next quote of EITHER kind - the two quote classes are independent in the patterns above,
 *  so a mismatched pair (`'./x"`) matches and must keep matching. */
function relativeSpecifierAt(source: string, quoteAt: number): { specifier: string; end: number } | null {
  const quote = source[quoteAt];
  if (quote !== "'" && quote !== '"') return null;
  let p = quoteAt + 1;
  if (source[p] !== '.') return null;
  if (source[++p] === '.') p++;
  if (source[p] !== '/') return null;
  const contentStart = ++p;
  while (p < source.length && source[p] !== "'" && source[p] !== '"') p++;
  if (p === contentStart || p >= source.length) return null;
  return { specifier: source.slice(quoteAt + 1, p), end: p + 1 };
}

/** First `;` or quote at or after `from`: where a greedy `[^;'"]*` has to stop. */
function nextClauseTerminator(source: string, from: number): number {
  for (let p = from; p < source.length; p++) {
    const c = source[p];
    if (c === ';' || c === "'" || c === '"') return p;
  }
  return -1;
}

/** The `\bfrom\s*` tail that must sit immediately before the opening quote at `at`, with the
 *  relative specifier it opens. `\s*` can only end where the quote begins, so `from` is at one
 *  fixed offset: the start of the whitespace run before the quote, minus its own length. */
function relativeFromTail(source: string, at: number): { fromAt: number; specifier: string } | null {
  const spec = relativeSpecifierAt(source, at);
  if (!spec) return null;
  let wsStart = at;
  while (wsStart > 0 && WS.test(source[wsStart - 1])) wsStart--;
  const fromAt = wsStart - 4;
  if (fromAt < 0 || !source.startsWith('from', fromAt)) return null;
  if (fromAt > 0 && WORD.test(source[fromAt - 1])) return null; // the `\b` before `from`
  return { fromAt, specifier: spec.specifier };
}

/**
 * `/(?:import|export)\b[^;'"]*\bfrom\s*['"](\.\.?\/[^'"]+)['"]/` without its per-keyword rescan of
 * the rest of the file (3.1s on 32k keywords, quadratic). The greedy `[^;'"]*` cannot cross a `;`
 * or a quote and the pattern's own opening quote has to follow `from\s*`, so that first terminator
 * IS the opening quote and `from` sits at one fixed offset before it: one candidate per keyword
 * instead of one per position. Leftmost keyword that completes the shape wins, as in the regex.
 */
function findRelativeImportFrom(source: string): string | null {
  let importAt = source.indexOf('import');
  let exportAt = source.indexOf('export');
  let terminator = -1;
  let tailFor = -1;
  let tail: { fromAt: number; specifier: string } | null = null;
  while (importAt !== -1 || exportAt !== -1) {
    let at: number;
    if (exportAt === -1 || (importAt !== -1 && importAt < exportAt)) {
      at = importAt;
      importAt = source.indexOf('import', at + 1);
    } else {
      at = exportAt;
      exportAt = source.indexOf('export', at + 1);
    }
    const afterKeyword = at + 6;
    if (WORD.test(source[afterKeyword] ?? '')) continue; // the `\b` after import/export
    // Both lookups are monotone in `afterKeyword`, so each one advances at most once per keyword.
    if (terminator < afterKeyword) {
      terminator = nextClauseTerminator(source, afterKeyword);
      if (terminator === -1) return null; // no `;`/quote left: no later keyword can match either
    }
    if (tailFor !== terminator) {
      tailFor = terminator;
      tail = relativeFromTail(source, terminator);
    }
    // `[^;'"]*` starts at the keyword, so a `from` before it belongs to an earlier statement.
    if (tail && tail.fromAt >= afterKeyword) return tail.specifier;
  }
  return null;
}

/** Exported for unit tests (differential vs the original patterns). */
export function findRelativeImport(source: string): string | null {
  const importFrom = findRelativeImportFrom(source);
  if (importFrom !== null) return importFrom;
  const sideEffect = source.match(RELATIVE_SIDE_EFFECT_IMPORT);
  if (sideEffect) return sideEffect[1];
  const required = source.match(RELATIVE_REQUIRE);
  return required ? required[1] : null;
}

function replaceImportStatements(
  source: string,
  opts: { typeKeyword?: boolean; consumeTrailing?: boolean },
  replace: (statement: ImportStatement, text: string) => string
): string {
  const statements = scanImportStatements(source, opts);
  if (!statements.length) return source;
  let out = '';
  let at = 0;
  for (const statement of statements) {
    out += source.slice(at, statement.index) + replace(statement, source.slice(statement.index, statement.end));
    at = statement.end;
  }
  return out + source.slice(at);
}

/** First `{...}` span, as `/\{([\s\S]*?)\}/` would find it but without its per-brace rescan: if the
 *  first `{` has no `}` after it, no later `{` does either. `greedy` matches `/\{([\s\S]*)\}/`. */
function braceSpan(text: string, greedy = false): { open: number; close: number } | null {
  const open = text.indexOf('{');
  if (open === -1) return null;
  const close = greedy ? text.lastIndexOf('}') : text.indexOf('}', open + 1);
  return close > open ? { open, close } : null;
}

/**
 * Remove TypeScript type-only import syntax, which carries no runtime binding. The import rewrite
 * and dependency scan below are regex passes that run BEFORE Babel's typescript preset, so they'd
 * otherwise emit broken `const { type Foo } = ...` or gate a type-only package as a missing runtime
 * dep. Runs on the raw source so the whole pipeline (relative-import guard, dep gating, rewrite)
 * sees value imports only. Idempotent. Only the MATCH SET is kept in sync with the sandbox preview
 * (react-artifact-sandbox.ts): that copy still emits the original regexes into the browser, so it
 * strips the same imports by a different implementation and keeps the super-linear behavior this
 * scanner replaced.
 *
 * Handles: whole-clause `import type { X } from 'm'` / `import type X from 'm'` (dropped), and
 * inline `import { type X, y } from 'm'` -> `import { y } from 'm'`. A binding literally named
 * `type` (`import type from 'm'`, `import { type as T } from 'm'`) is preserved - `type` is only
 * a modifier when followed by another binding identifier that is not `as`.
 */
export function stripTypeOnlyImports(source: string): string {
  const withoutTypeStatements = replaceImportStatements(source, { typeKeyword: true, consumeTrailing: true }, () => '');
  return replaceImportStatements(withoutTypeStatements, { consumeTrailing: true }, ({ clause }, text) => {
    const braces = braceSpan(clause);
    if (!braces) return text;
    const kept = clause
      .slice(braces.open + 1, braces.close)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(spec => !/^type\s+(?!as\b)\w/.test(spec));
    // No value bindings left and no default/namespace before the brace -> whole import was type-only.
    const beforeBrace = clause.slice(0, braces.open).replace(/,\s*$/, '').trim();
    if (!kept.length && !beforeBrace) return '';
    const inText = braceSpan(text);
    return inText ? `${text.slice(0, inText.open)}{ ${kept.join(', ')} }${text.slice(inText.close + 1)}` : text;
  });
}

/** React APIs pre-injected as bare globals in the bootstrap (see HOOK_GLOBALS). A named import of
 *  one of these is dropped (already global); any OTHER named React import is bound from `React`. */
const HOOK_GLOBAL_NAMES: readonly string[] = [
  'useState',
  'useEffect',
  'useRef',
  'useMemo',
  'useCallback',
  'useReducer',
  'useContext',
  'createContext',
];

/**
 * Rewrite ESM imports so the classic-runtime output runs as a plain script with no module loader:
 *  - `react`: a default/namespace import is dropped (React is a runtime global); NAMED react imports
 *    NOT already covered by HOOK_GLOBALS (useLayoutEffect, useId, forwardRef, memo, ...) are bound
 *    from `React` so they resolve instead of throwing ReferenceError at first render.
 *  - other modules map to `require('pkg')`, handling default / named / namespace / mixed forms.
 * Statement boundaries come from scanImportStatements, so adjacent semicolon-less imports (valid
 * via ASI) are not conflated into one broken match. Exported for unit tests.
 */
export function rewriteImportsToRequire(rawSource: string): string {
  const source = stripTypeOnlyImports(rawSource); // TS type imports have no runtime binding
  // Convert ESM `X as Y` renames in a named-imports clause to valid destructuring `X: Y`
  // (a raw `const { X as Y } = ...` is a syntax error that would blank the published page).
  const renameNamedBindings = (named: string): string =>
    named
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(spec => {
        const m = spec.match(/^(\w+)\s+as\s+(\w+)$/);
        return m ? `${m[1]}: ${m[2]}` : spec;
      })
      .join(', ');
  const rewritten = replaceImportStatements(source, {}, ({ clause: clauseRaw, specifier: mod }) => {
    const clause = clauseRaw.trim();
    const named = braceSpan(clause, true);
    const namedRaw = named ? clause.slice(named.open + 1, named.close).trim() : '';
    const nsMatch = clause.match(/\*\s+as\s+(\w+)/);
    const defMatch = clause.match(/^(\w+)\b/); // leading bare identifier = default binding
    const hasDefault = !!defMatch && !clause.startsWith('{') && !clause.startsWith('*');

    if (mod === 'react') {
      if (!namedRaw) return '// react is a runtime global';
      const binds = namedRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(spec => {
          const asM = spec.match(/^(\w+)\s+as\s+(\w+)$/); // `Name as alias` -> `Name: alias`
          return asM ? { local: asM[2], code: `${asM[1]}: ${asM[2]}` } : { local: spec, code: spec };
        })
        .filter(b => !HOOK_GLOBAL_NAMES.includes(b.local)); // skip already-global names (no redeclare)
      return binds.length ? `const { ${binds.map(b => b.code).join(', ')} } = React;` : '// react is a runtime global';
    }

    if (nsMatch) return `const ${nsMatch[1]} = require('${mod}');`;
    if (hasDefault && namedRaw) {
      // mixed default + named: bind the default to the module, then destructure the named off it.
      return `const ${defMatch![1]} = require('${mod}'); const { ${renameNamedBindings(namedRaw)} } = ${defMatch![1]};`;
    }
    if (namedRaw) return `const { ${renameNamedBindings(namedRaw)} } = require('${mod}');`;
    if (hasDefault) return `const ${defMatch![1]} = require('${mod}');`;
    return `const ${clause} = require('${mod}');`;
  });

  // The shape above is always rewritable, so a survivor means the scanner missed one. Failing the
  // publish beats serving a page that dies with "Cannot use import statement outside a module".
  const survivor = findSurvivingEsmImport(rewritten);
  if (survivor) {
    throw new ReactArtifactTranspileError(
      `Could not rewrite an ESM import for a script bundle: ${JSON.stringify(survivor.slice(0, 120))}`
    );
  }
  return rewritten;
}

/**
 * A line-initial `import ... from '<spec>'` still present after the rewrite. Deliberately NOT built
 * on scanImportStatements - a check sharing the scanner could never catch a gap in it. Each
 * statement is bounded by the first `;` or quote after it and the cursor only advances, so this
 * stays linear on the `from`-less input that made the original regexes quadratic.
 *
 * The leading class is the one assertPublishableDependencies uses: every whitespace character
 * except a line terminator, so an import indented with \f or U+00A0 is still line-initial here.
 *
 * Known blind spot: a survivor that isn't line-initial (e.g. after a `;` on the same line) escapes
 * this pattern. Narrow in practice - scanImportStatements has no line anchor and already rewrites
 * those, so this only misses one if the scanner has separately failed on that input.
 */
function findSurvivingEsmImport(code: string): string | null {
  const lineInitialImport = /^[^\S\n\r\u2028\u2029]*import\s/gm;
  let m: RegExpExecArray | null;
  while ((m = lineInitialImport.exec(code)) !== null) {
    const importEnd = m.index + m[0].length - 1; // the mandatory whitespace char after `import`
    let p = importEnd;
    while (p < code.length && code[p] !== ';' && code[p] !== "'" && code[p] !== '"') p++;
    let r = p + 1;
    if (p < code.length && code[p] !== ';') {
      while (r < code.length && code[r] !== "'" && code[r] !== '"') r++;
      let q = p;
      while (q > importEnd && WS.test(code[q - 1])) q--;
      // The full rewritable shape: a non-empty quoted specifier, and `\s+` on BOTH sides of the
      // clause. A one-space `import from 'x'`, a `}from 'm'` and an empty `from ''` are none of
      // them rewritable nor scanner matches, so none may trip the net.
      const quoted = r > p + 1 && r < code.length;
      if (quoted && q < p && code.slice(q - 4, q) === 'from' && q - 4 - importEnd >= 2 && WS.test(code[q - 5])) {
        return code.slice(m.index, r + 1);
      }
    }
    // Resume just past the clause terminator, not past `r`: the quote scan for `r` may cross a
    // line terminator, and skipping to it would step over a line-initial import on the next line.
    // Runs stay disjoint either way (the next start is past this statement's first quote/`;`).
    lineInitialImport.lastIndex = p + 1;
  }
  return null;
}

/** Module specifiers from real `import ... from '...'` statements (non-relative only). */
function extractImportedModules(rawSource: string): string[] {
  const source = stripTypeOnlyImports(rawSource); // don't gate a type-only import as a runtime dep
  const mods = new Set<string>();
  for (const { specifier } of scanImportStatements(source)) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) mods.add(specifier);
  }
  return [...mods];
}

/**
 * Reject any imported module that is not publishable yet. Uses an IMPORT-ONLY scan (real
 * `import ... from '...'` statements) - deliberately NOT `extractReactDependencies`, whose
 * lucide-react auto-detect would flag any artifact merely NAMING a common icon identifier
 * (Settings, Home, Bell, Star, User, ...) and 422 a component that never imported lucide.
 */
export function assertPublishableDependencies(source: string): void {
  // Bare side-effect imports (`import 'x';`) match neither extractImportedModules nor the rewrite,
  // so they would survive into the classic inline <script> and blank the page (parse error before
  // the render try/catch). Reject cleanly instead.
  // The leading run excludes line terminators rather than spelling out [ \t]: /m already anchors
  // ^ at every line start, so a run that crossed one only re-reached a position ^ matches anyway,
  // and excluding them is what stops a file of bare newlines from rescanning to end at each start.
  // Every other \s character stays in, so \f, \v and \u00a0 before an import still match.
  if (/^[^\S\n\r\u2028\u2029]*import\s+['"]/m.test(source)) {
    throw new ReactArtifactTranspileError(
      'Side-effect imports (import "...") are not supported. Import a default or named binding, or inline the code.'
    );
  }
  for (const dep of extractImportedModules(source)) {
    if (!PUBLISH_SUPPORTED_DEPENDENCIES.includes(dep)) {
      throw new UnsupportedReactDependencyError(dep);
    }
  }
}

/**
 * Unwrap the default export into the local the bootstrap reads. Handles BOTH forms
 * checkHasDefaultExport accepts - `export default X` and `export { X as default }` - because Babel
 * (preset-react only) leaves module syntax untouched, so an unhandled `export { ... }` would
 * survive into the classic inline <script> and fail to parse (silently blanking the page).
 * Anchored to line-start (`m`): Babel emits top-level exports at column 0, so this rewrites the
 * real statement but NOT a literal "export default ..." embedded in a string / JSX text. The
 * leading run excludes line terminators for the reason spelled out on the side-effect guard above,
 * and both forms keep it in a capture so the statement's indentation survives the rewrite.
 * Exported for unit tests.
 */
export function unwrapDefaultExport(transformed: string): string {
  return transformed
    .replace(/^([^\S\n\r\u2028\u2029]*)export\s+default\s+/gm, '$1const __DEFAULT_EXPORT__ = ')
    .replace(
      /^([^\S\n\r\u2028\u2029]*)export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}\s*;?/gm,
      '$1const __DEFAULT_EXPORT__ = $2;'
    );
}

/**
 * JSX -> inert classic-runtime JS. Rewrites imports, transpiles JSX to `React.createElement`
 * via @babel/standalone, then unwraps `export default` into a `__DEFAULT_EXPORT__` local the
 * bootstrap reads. Output contains no import/export statements and no eval.
 */
export async function transpileReactSource(source: string): Promise<string> {
  // Strip type-only imports first so a type-only relative import isn't misread as a multi-file ref.
  const cleaned = stripTypeOnlyImports(source);
  const relImport = findRelativeImport(cleaned);
  if (relImport) {
    throw new ReactArtifactTranspileError(
      `Multi-file artifacts are not supported: this one references "${relImport}" from a separate file. ` +
        `Provide a single self-contained component (one file, one default export).`
    );
  }

  const Babel = await getBabel();
  const withRequires = rewriteImportsToRequire(cleaned);

  let transformed: string | null | undefined;
  try {
    // Classic runtime: emit React.createElement against the React global (the AUTOMATIC runtime
    // injects `import { jsx } from "react/jsx-runtime"`, fatal in a no-module-loader script).
    // The `typescript` preset strips TS syntax (types/generics/interfaces the assistant emits by
    // default); presets run last-to-first, so types are stripped BEFORE the JSX transform. TSX is
    // detected via the `.tsx` filename - NOT preset-typescript's allExtensions/isTSX options, which
    // conflict with preset-react JSX detection and break the plain-JS path.
    // Identical config to the in-app sandbox (react-artifact-sandbox.ts) so a published artifact
    // renders the same as the chat preview - keep the two in sync.
    transformed = Babel.transform(withRequires, {
      presets: [['react', { runtime: 'classic' }], 'typescript'],
      filename: 'component.tsx',
    }).code;
  } catch (e) {
    throw new ReactArtifactTranspileError(`JSX transform failed: ${(e as Error).message}`);
  }
  if (!transformed) {
    throw new ReactArtifactTranspileError('JSX transform produced no output.');
  }

  const unwrapped = unwrapDefaultExport(transformed);

  // Authoritative default-export check: checkHasDefaultExport (the pre-check) is intentionally
  // lenient (unanchored) and matches "export default" even inside a string, so a source whose only
  // "export default" is string-embedded would otherwise transpile fine and then throw at RENDER.
  // Assert a REAL top-level export was unwrapped, keeping the "reject at publish, not render" contract.
  if (!unwrapped.includes('__DEFAULT_EXPORT__')) {
    throw new ReactArtifactTranspileError(
      'React artifact must export a component as its default export (e.g. `export default MyComponent`).'
    );
  }
  return unwrapped;
}

const HOOK_GLOBALS = `var ${HOOK_GLOBAL_NAMES.map(h => `${h}=React.${h}`).join(',')};`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A blessed `<script src>` tag. Absolute app-host form when SERVER_DOMAIN is set (so it loads
 *  from the app origin even on the isolated `*.usercontent.app` serve origin); relative otherwise
 *  (local dev serves them same-origin). Both forms pass validateBundle. */
function blessedScriptTag(path: string): string {
  const src = PUBLISH_HOST ? `https://${PUBLISH_HOST}${path}` : path;
  return `<script src="${src}"></script>`;
}

/** Blessed React runtime `<script src>` tags (react + react-dom + prop-types). */
function reactRuntimeScriptTags(): string {
  return REACT_BLESSED_SCRIPT_PATHS.map(blessedScriptTag).join('\n');
}

/**
 * Builds `window.LucideReactWrapper` from the blessed `lucide` UMD (global `lucide`), embedded in
 * the bootstrap when a bundle imports `lucide-react`. The factory itself is the shared LUCIDE_WRAPPER_FN
 * (single source of truth with the in-app sandbox at react-artifact-sandbox.ts); here we append the
 * call so the wrapper is set up as the bootstrap runs. LUCIDE_WRAPPER_FN carries no closing-script-tag
 * sequence, so it is safe inside the inline bootstrap.
 */
const LUCIDE_WRAPPER_SETUP = `${LUCIDE_WRAPPER_FN}\n  setupLucideWrapper();`;

/**
 * Assemble the final inert index.html: blessed React runtime scripts + any blessed optional-dep
 * UMDs the artifact imports + a single inline bootstrap that defines the hook/require globals,
 * runs the transpiled component, and mounts it. No eval, no external non-blessed scripts.
 *
 * `dependencies` are the optional module specifiers the artifact imports (react excluded); each
 * must be a key of PUBLISH_REACT_DEP_SCRIPTS (buildReactArtifactBundle guarantees this via
 * assertPublishableDependencies). Dep UMDs load AFTER the React runtime because they externalize
 * React/ReactDOM/PropTypes (e.g. recharts) and would throw at init otherwise.
 */
export function assembleReactBundleHtml(input: {
  title: string;
  transpiledCode: string;
  dependencies?: readonly string[];
}): string {
  // hasOwnProperty (not `in`): `in` walks the prototype chain, so a module named `constructor`,
  // `toString`, etc. would falsely match and yield an undefined path/global.
  const deps = (input.dependencies ?? []).filter(d =>
    Object.prototype.hasOwnProperty.call(PUBLISH_REACT_DEP_SCRIPTS, d)
  );
  // A literal `</script>` inside the transpiled code (e.g. in a string literal) would close the
  // inline script early; escape it. In a JS string `<\/script>` is identical to `</script>`.
  const safeCode = input.transpiledCode.replace(/<\/(script)/gi, '<\\/$1');
  const title = escapeHtml(input.title || 'React artifact');

  const depScriptTags = deps.map(d => blessedScriptTag(PUBLISH_REACT_DEP_SCRIPTS[d].path)).join('\n');
  // lucide-react's require() target (LucideReactWrapper) is built from the loaded `lucide` UMD,
  // so the shim must run before moduleMap references window.LucideReactWrapper.
  const lucideSetup = deps.includes('lucide-react') ? LUCIDE_WRAPPER_SETUP : '';
  const moduleMapEntries = deps
    .map(d => `,${JSON.stringify(d)}:window.${PUBLISH_REACT_DEP_SCRIPTS[d].global}`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;padding:0}*{box-sizing:border-box}#root{min-height:100vh}.b4m-artifact-error{color:#b91c1c;background:#fee2e2;padding:12px;border-radius:4px;border-left:4px solid #b91c1c;font-family:monospace;font-size:12px;white-space:pre-wrap}</style>
${reactRuntimeScriptTags()}${depScriptTags ? '\n' + depScriptTags : ''}
</head><body>
<div id="root"></div>
<script>
(function(){
  var root=document.getElementById('root');
  function showError(msg){root.innerHTML='';var b=document.createElement('div');b.className='b4m-artifact-error';b.textContent='Error: '+String(msg);root.appendChild(b);}
  try{
    var React=window.React,ReactDOM=window.ReactDOM;
    ${HOOK_GLOBALS}
    ${lucideSetup}
    var moduleMap={'react':React${moduleMapEntries}};
    var require=function(m){if(Object.prototype.hasOwnProperty.call(moduleMap,m))return moduleMap[m];throw new Error('Module "'+m+'" is not available');};
    ${safeCode}
    var __c=(typeof __DEFAULT_EXPORT__!=='undefined')?__DEFAULT_EXPORT__:null;
    if(!__c){throw new Error('No default-exported component found');}
    ReactDOM.createRoot(root).render(React.createElement(__c));
  }catch(e){showError((e&&e.message)||e);}
})();
</script>
</body></html>`;
}

/**
 * Top-level entry: validate deps, transpile, and assemble the inert HTML bundle for a React
 * artifact. Throws UnsupportedReactDependencyError / ReactArtifactTranspileError on rejectable
 * input so the finalize handler can surface a clean validation violation.
 */
export async function buildReactArtifactBundle(input: {
  source: string;
  title: string;
}): Promise<{ indexHtml: string }> {
  if (!checkHasDefaultExport(input.source)) {
    // Reject at publish time rather than shipping a bundle that only errors once rendered.
    throw new ReactArtifactTranspileError(
      'React artifact must export a component as its default export (e.g. `export default MyComponent`).'
    );
  }
  assertPublishableDependencies(input.source);
  const dependencies = extractImportedModules(input.source).filter(m =>
    Object.prototype.hasOwnProperty.call(PUBLISH_REACT_DEP_SCRIPTS, m)
  );
  const transpiledCode = await transpileReactSource(input.source);
  return { indexHtml: assembleReactBundleHtml({ title: input.title, transpiledCode, dependencies }) };
}
