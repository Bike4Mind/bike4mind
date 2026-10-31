import { REACT_BLESSED_SCRIPT_PATHS, PUBLISH_REACT_DEP_SCRIPTS } from '@bike4mind/common';
import { checkHasDefaultExport } from '@bike4mind/server-utils/app/utils/artifactParser';
import {
  braceSpan,
  findRelativeImport,
  findRelativeImports,
  moduleBaseName,
  scanImportStatements,
  stripTypeOnlyImports,
  type ImportStatement,
} from '@client/app/utils/importStatements';
import { LUCIDE_WRAPPER_FN } from '@client/app/utils/reactArtifactDeps';
import {
  ARTIFACT_MODULE_RUNTIME_FACTORY_SRC,
  createArtifactModuleResolver,
} from '@client/app/utils/reactArtifactModules';
import { PUBLISH_HOST } from './validateBundle';

/**
 * Publish-time React transpiler (issue #21): converts a single-file React/JSX artifact into a
 * self-contained, INERT, eval-free HTML bundle the existing publisher can serve unchanged.
 *
 * This is the SERVER-SIDE counterpart of the in-app render at
 * `apps/client/pages/api/react-artifact-sandbox.ts` (inert mode): same import scan (the rewrite
 * callbacks differ, see replaceImportStatements below) + default-export unwrap + hook-injection
 * steps, and the same transpiler (`@babel/standalone`,
 * classic runtime) - but the JSX->`React.createElement` step runs once here at publish instead of
 * in the browser, so the published bundle matches the chat preview. The emitted
 * bundle uses only an inline `<script>` (no eval/new Function/document.write/string timers) plus
 * blessed `<script src>` for the React runtime, so it passes `validateBundle` and renders on the
 * isolated serve origin (whose CSP is `script-src 'unsafe-inline' 'self' <blessed>`).
 *
 * Multi-file apps (an entry plus sibling files it imports relatively) link through the module
 * runtime the sandbox uses (app/utils/reactArtifactModules.ts), all inside the same one inline
 * script; a source with no relative import takes the original single-file path unchanged.
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

/** Thrown when a relative import cannot be resolved, there is no default export, or a transpile fails. */
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
const RELATIVE_SPECIFIER = /^\.\.?\//;

// Statement boundaries and the type-only strip come from @client/app/utils/importStatements, whose
// factory source the sandbox preview (apps/client/pages/api/react-artifact-sandbox.ts) evaluates in
// the browser. The import-rewrite callback below is NOT shared: the sandbox keeps its own (it drops
// every react import, where this one binds non-hook names). Which imports are real (relative,
// package or side-effect) is decided from Babel's parse instead (analyzeModuleReferences).
export { findRelativeImport, stripTypeOnlyImports };

type AstNode = { type: string } & Record<string, unknown>;

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function stringLiteralValue(node: unknown): string | null {
  return isAstNode(node) && node.type === 'StringLiteral' && typeof node.value === 'string' ? node.value : null;
}

// Child keys that never hold code: comments carry the very text this parse exists to ignore.
const NON_CODE_KEYS = new Set(['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments']);

/** Visits every code node of a Babel AST in source order. An explicit stack with children pushed in
 *  reverse, so deeply nested user code cannot overflow it. */
function walkAst(ast: unknown, visit: (node: AstNode) => void): void {
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!isAstNode(node)) continue;
    visit(node);
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      if (!NON_CODE_KEYS.has(keys[i])) stack.push(node[keys[i]]);
    }
  }
}

function parseModule(Babel: typeof import('@babel/standalone'), source: string) {
  try {
    return Babel.packages.parser.parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return null;
  }
}

/**
 * A module `source` loads at run time. `binding`: an import declaration that binds names (what the
 * classic-script rewrite turns into `require()`); `side-effect`: `import 'x'`; `load`: export-from,
 * `require('x')` and `import X = require('x')`; `dynamic` is a rejected browser import().
 */
type ModuleReference = { specifier: string; kind: 'binding' | 'side-effect' | 'load' | 'dynamic' };

/** null when the source does not parse, so callers fall back to the text scans. */
type Analyze = (source: string) => Promise<ModuleReference[] | null>;

/**
 * Every runtime module reference in `source`, in source order, from Babel's parse. Comments and
 * string/template/JSX text never count: the preview only loads what Babel compiles from real
 * imports. Type-only imports and exports are skipped.
 */
async function analyzeModuleReferences(source: string): Promise<ModuleReference[] | null> {
  const Babel = await getBabel();
  const ast = parseModule(Babel, source);
  if (ast === null) return null;
  const shadowedRequires = new Set<unknown>();
  Babel.packages.traverse.default(ast, {
    CallExpression(path) {
      if (path.scope.hasBinding('require')) shadowedRequires.add(path.node);
    },
  });
  const found: ModuleReference[] = [];
  const add = (specifier: string | null, kind: ModuleReference['kind']): void => {
    if (specifier !== null) found.push({ specifier, kind });
  };
  walkAst(ast, node => {
    switch (node.type) {
      case 'ImportDeclaration': {
        const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
        const typeOnly =
          node.importKind === 'type' ||
          node.importKind === 'typeof' ||
          (specifiers.length > 0 && specifiers.every(s => isAstNode(s) && s.importKind === 'type'));
        if (typeOnly) break;
        // `import {} from 'x'` also has no specifiers but is not the bare form the rewrite cannot bind.
        const sourceStart = isAstNode(node.source) ? node.source.start : undefined;
        const bare =
          specifiers.length === 0 &&
          typeof node.start === 'number' &&
          typeof sourceStart === 'number' &&
          !source.slice(node.start, sourceStart).includes('{');
        add(stringLiteralValue(node.source), bare ? 'side-effect' : 'binding');
        break;
      }
      case 'ExportNamedDeclaration': {
        const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
        const typeOnly = specifiers.length > 0 && specifiers.every(s => isAstNode(s) && s.exportKind === 'type');
        if (node.exportKind !== 'type' && !typeOnly) add(stringLiteralValue(node.source), 'load');
        break;
      }
      case 'ExportAllDeclaration':
        if (node.exportKind !== 'type') add(stringLiteralValue(node.source), 'load');
        break;
      case 'ImportExpression':
        add(stringLiteralValue(node.source) ?? '', 'dynamic');
        break;
      case 'CallExpression': {
        const callee = node.callee;
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const loads =
          isAstNode(callee) &&
          (callee.type === 'Import' ||
            (callee.type === 'Identifier' && callee.name === 'require' && !shadowedRequires.has(node)));
        if (loads && args.length === 1) {
          const dynamic = isAstNode(callee) && callee.type === 'Import';
          add(stringLiteralValue(args[0]) ?? (dynamic ? '' : null), dynamic ? 'dynamic' : 'load');
        }
        break;
      }
      case 'TSImportEqualsDeclaration':
        if (node.importKind !== 'type' && isAstNode(node.moduleReference)) {
          add(stringLiteralValue(node.moduleReference.expression), 'load');
        }
        break;
    }
  });
  return found;
}

/** One parse per distinct source for the duration of a build. */
function memoizedAnalyze(): Analyze {
  const cache = new Map<string, Promise<ModuleReference[] | null>>();
  return source => {
    let analysis = cache.get(source);
    if (!analysis) {
      analysis = analyzeModuleReferences(source);
      cache.set(source, analysis);
    }
    return analysis;
  };
}

function relativeSpecifiers(source: string, references: ModuleReference[] | null): string[] {
  // Unparseable: keep the text scan so the transform itself reports the error, file name included.
  if (references === null) return findRelativeImports(stripTypeOnlyImports(source));
  const found: string[] = [];
  for (const { specifier } of references) {
    if (RELATIVE_SPECIFIER.test(specifier) && !found.includes(specifier)) found.push(specifier);
  }
  return found;
}

/**
 * Every distinct relative specifier `source` loads at run time (value import/export-from, side-effect
 * import, `require('./x')`, `import('./x')`), in source order, from Babel's parse. The preview's module
 * runtime only resolves the require() calls Babel's CommonJS transform emits for these, so a path
 * that appears only in a comment or a string is never one, and must not be one here either.
 */
export async function findRelativeModuleReferences(source: string): Promise<string[]> {
  return relativeSpecifiers(source, await analyzeModuleReferences(source));
}

/** External runtime references, including re-exports and require(), whose UMDs must be inlined. */
function packageImports(source: string, references: ModuleReference[] | null): string[] {
  if (references === null) return extractImportedModules(source);
  const mods = new Set<string>();
  for (const { specifier, kind } of references) {
    if ((kind === 'binding' || kind === 'load') && !RELATIVE_SPECIFIER.test(specifier)) mods.add(specifier);
  }
  return [...mods];
}

/** assertPublishableDependencies decided from the parse; the text checks only for unparseable input. */
function assertPublishableReferences(
  source: string,
  references: ModuleReference[] | null,
  options: { allowRelativeSideEffects?: boolean } = {}
): void {
  if (references === null) {
    assertPublishableDependencies(source, options);
    return;
  }
  for (const { specifier, kind } of references) {
    if (kind === 'dynamic') {
      throw new ReactArtifactTranspileError(
        'Dynamic imports are not supported for publish. Use a static import instead.'
      );
    }
    if (kind === 'side-effect' && !(options.allowRelativeSideEffects && RELATIVE_SPECIFIER.test(specifier))) {
      throw new ReactArtifactTranspileError(SIDE_EFFECT_IMPORT_MESSAGE);
    }
  }
  for (const dep of packageImports(source, references)) {
    if (!PUBLISH_SUPPORTED_DEPENDENCIES.includes(dep)) {
      throw new UnsupportedReactDependencyError(dep);
    }
  }
}

// Uses the module's scanImportStatements binding (not the factory-internal one) so the survivor
// tests can stub the scan and prove findSurvivingEsmImport catches what it misses.
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
export function rewriteImportsToRequire(rawSource: string, opts: { keepRelative?: boolean } = {}): string {
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
  const rewritten = replaceImportStatements(source, {}, ({ clause: clauseRaw, specifier: mod }, text) => {
    // Sibling imports are left for Babel's CommonJS transform, which gives them ESM interop.
    if (opts.keepRelative && RELATIVE_SPECIFIER.test(mod)) return text;
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
  // With keepRelative the caller runs this check on the CommonJS output instead.
  if (!opts.keepRelative) assertNoSurvivingEsmImport(rewritten);
  return rewritten;
}

/** Rewrite only parsed import declarations; import text in user content must stay byte-for-byte intact. */
function rewriteRealImports(Babel: typeof import('@babel/standalone'), source: string): string {
  const ast = parseModule(Babel, source);
  if (ast === null) return rewriteImportsToRequire(source, { keepRelative: true });
  const declarations: AstNode[] = [];
  walkAst(ast, node => {
    if (node.type === 'ImportDeclaration') declarations.push(node);
  });
  declarations.sort((left, right) => Number(left.start) - Number(right.start));
  let result = '';
  let cursor = 0;
  for (const declaration of declarations) {
    if (typeof declaration.start !== 'number' || typeof declaration.end !== 'number') continue;
    result += source.slice(cursor, declaration.start);
    const rewritten = rewriteImportsToRequire(source.slice(declaration.start, declaration.end), { keepRelative: true });
    const followedByNewline = /^[^\S\n\r]*(?:[\n\r]|$)/.test(source.slice(declaration.end));
    result += rewritten.startsWith('//') && !followedByNewline ? `${rewritten}\n` : rewritten;
    cursor = declaration.end;
  }
  return result + source.slice(cursor);
}

function assertNoSurvivingEsmImport(code: string): void {
  const survivor = findSurvivingEsmImport(code);
  if (survivor) {
    throw new ReactArtifactTranspileError(
      `Could not rewrite an ESM import for a script bundle: ${JSON.stringify(survivor.slice(0, 120))}`
    );
  }
}

/**
 * assertNoSurvivingEsmImport for code Babel can parse: a candidate that starts inside a comment or a
 * string/template/JSX text is that text, not a statement. The parse runs only once a candidate exists,
 * and code that does not parse gets the plain check.
 */
function assertNoSurvivingEsmImportInCode(Babel: typeof import('@babel/standalone'), code: string): void {
  if (findSurvivingEsmImport(code) === null) return;
  const ast = parseModule(Babel, code);
  if (ast === null) {
    assertNoSurvivingEsmImport(code);
    return;
  }
  const ranges: [number, number][] = [];
  const addRange = (node: unknown): void => {
    if (isAstNode(node) && typeof node.start === 'number' && typeof node.end === 'number') {
      ranges.push([node.start, node.end]);
    }
  };
  const comments = (ast as { comments?: unknown }).comments;
  if (Array.isArray(comments)) comments.forEach(addRange);
  walkAst(ast, node => {
    if (
      node.type === 'StringLiteral' ||
      node.type === 'DirectiveLiteral' ||
      node.type === 'TemplateElement' ||
      node.type === 'JSXText'
    ) {
      addRange(node);
    }
  });
  ranges.sort((a, b) => a[0] - b[0]);
  // Candidates arrive in increasing order and the ranges are disjoint, so one forward cursor suffices.
  let i = 0;
  const survivor = findSurvivingEsmImport(code, at => {
    while (i < ranges.length && ranges[i][1] <= at) i++;
    return i < ranges.length && ranges[i][0] <= at;
  });
  if (survivor) {
    throw new ReactArtifactTranspileError(
      `Could not rewrite an ESM import for a script bundle: ${JSON.stringify(survivor.slice(0, 120))}`
    );
  }
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
function findSurvivingEsmImport(code: string, insideLiteral?: (at: number) => boolean): string | null {
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
        if (!insideLiteral?.(importEnd - 6)) return code.slice(m.index, r + 1);
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

const SIDE_EFFECT_IMPORT_MESSAGE =
  'Side-effect imports (import "...") are not supported. Import a default or named binding, or inline the code.';

/**
 * Reject any imported module that is not publishable yet. Uses an IMPORT-ONLY scan (real
 * `import ... from '...'` statements) - deliberately NOT `extractReactDependencies`, whose
 * lucide-react auto-detect would flag any artifact merely NAMING a common icon identifier
 * (Settings, Home, Bell, Star, User, ...) and 422 a component that never imported lucide.
 *
 * Text-based and sync, so it also reads import text inside comments and strings: the build decides
 * from Babel's parse (assertPublishableReferences) and uses this only for a source that does not parse.
 */
export function assertPublishableDependencies(
  source: string,
  options: { allowRelativeSideEffects?: boolean } = {}
): void {
  // Bare side-effect imports (`import 'x';`) match neither extractImportedModules nor the rewrite,
  // so they would survive into the classic inline <script> and blank the page (parse error before
  // the render try/catch). Reject cleanly instead.
  // The leading run excludes line terminators rather than spelling out [ \t]: /m already anchors
  // ^ at every line start, so a run that crossed one only re-reached a position ^ matches anyway,
  // and excluding them is what stops a file of bare newlines from rescanning to end at each start.
  // Every other \s character stays in, so \f, \v and \u00a0 before an import still match.
  // The multi-file path links `import './x'` through its module runtime, so it may skip relative ones.
  const sideEffectImport = options.allowRelativeSideEffects
    ? /^[^\S\n\r\u2028\u2029]*import\s+['"](?!\.\.?\/)/m
    : /^[^\S\n\r\u2028\u2029]*import\s+['"]/m;
  if (sideEffectImport.test(source)) {
    throw new ReactArtifactTranspileError(SIDE_EFFECT_IMPORT_MESSAGE);
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
  return transpileSingleFile(source, analyzeModuleReferences);
}

async function transpileSingleFile(source: string, analyze: Analyze): Promise<string> {
  // This path has no sibling files, so any real relative import gets the missing-file error.
  await resolveFiles(source, {}, analyze);
  const Babel = await getBabel();
  // Past the check above, a relative statement the text scan finds sits in a comment or a string:
  // keep it verbatim, as the preview's module path does.
  const withRequires = rewriteRealImports(Babel, source);
  assertNoSurvivingEsmImportInCode(Babel, withRequires);

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

/**
 * The keys of `files` the entry reaches through its relative imports, transitively, in `files`
 * order. Throws the module runtime's own "Cannot resolve" error, as a ReactArtifactTranspileError,
 * for an import that matches no file or several, so publish rejects what the page would fail on.
 */
export async function resolveReactArtifactFiles(entry: string, files: Record<string, string>): Promise<string[]> {
  return resolveFiles(entry, files, analyzeModuleReferences);
}

async function resolveFiles(entry: string, files: Record<string, string>, analyze: Analyze): Promise<string[]> {
  const keys = Object.keys(files);
  const resolve = createArtifactModuleResolver(moduleBaseName, keys);
  const reached = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const source = queue.shift() as string;
    for (const specifier of relativeSpecifiers(source, await analyze(source))) {
      let key: string;
      try {
        key = resolve(specifier);
      } catch (e) {
        throw new ReactArtifactTranspileError((e as Error).message);
      }
      if (!reached.has(key)) {
        reached.add(key);
        queue.push(files[key]);
      }
    }
  }
  return keys.filter(key => reached.has(key));
}

/** One file as a CommonJS module body: npm imports bound like the single-file path, sibling
 *  imports and exports converted by Babel's `transform-modules-commonjs`. */
async function transpileReactModule(source: string, filename: string): Promise<string> {
  const Babel = await getBabel();
  const withRequires = rewriteRealImports(Babel, source);
  let transformed: string | null | undefined;
  try {
    // The sandbox's module transform (react-artifact-sandbox.ts transpileModule): same presets and plugin.
    transformed = Babel.transform(withRequires, {
      presets: [['react', { runtime: 'classic' }], 'typescript'],
      plugins: ['transform-modules-commonjs'],
      filename,
    }).code;
  } catch (e) {
    throw new ReactArtifactTranspileError(`JSX transform failed: ${(e as Error).message}`);
  }
  if (!transformed) {
    throw new ReactArtifactTranspileError(`JSX transform produced no output for ${filename}.`);
  }
  assertNoSurvivingEsmImportInCode(Babel, transformed);
  return transformed;
}

function moduleFactory(body: string): string {
  return `function (module, exports, require) {\n${body}\n}`;
}

/**
 * The entry and its reached sibling files as ONE program for the bundle's inline script: each file
 * becomes a CommonJS factory, linked by the shared module runtime, and the entry's default export
 * lands in the `__DEFAULT_EXPORT__` local the bootstrap mounts. Does not check that imports
 * resolve (resolveReactArtifactFiles does); the runtime throws its own error for one that does not.
 */
export async function transpileReactModuleProgram(entry: string, files: Record<string, string>): Promise<string> {
  const siblings: string[] = [];
  for (const key of Object.keys(files)) {
    // Always .tsx so every file gets TS + JSX like the entry, matching the sandbox's file names.
    const filename = `${key
      .split('/')
      .pop()!
      .replace(/\.[cm]?[jt]sx?$/i, '')}.tsx`;
    siblings.push(`[${JSON.stringify(key)}, ${moduleFactory(await transpileReactModule(files[key], filename))}]`);
  }
  const entryBody = await transpileReactModule(entry, 'component.tsx');
  // The CommonJS counterpart of transpileReactSource's authoritative default-export check.
  // `export { X as default } from './F'` compiles to Object.defineProperty(exports, "default", ...).
  if (!/\bexports\.default\b|\bexports,\s*["']default["']/.test(entryBody)) {
    throw new ReactArtifactTranspileError(
      'React artifact must export a component as its default export (e.g. `export default MyComponent`).'
    );
  }
  return (
    `var __DEFAULT_EXPORT__ = (${ARTIFACT_MODULE_RUNTIME_FACTORY_SRC})().run(${String(moduleBaseName)}, require, [\n` +
    `${siblings.join(',\n')}\n], ${moduleFactory(entryBody)});`
  );
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
 *
 * `files` maps sibling identifiers to their source for an entry that imports them relatively. An
 * entry with no relative import ignores it and builds exactly as a single file; one with a
 * relative import resolves it against `files` (none given means none available).
 */
export async function buildReactArtifactBundle(input: {
  source: string;
  title: string;
  files?: Record<string, string>;
}): Promise<{ indexHtml: string }> {
  if (!checkHasDefaultExport(input.source)) {
    // Reject at publish time rather than shipping a bundle that only errors once rendered.
    throw new ReactArtifactTranspileError(
      'React artifact must export a component as its default export (e.g. `export default MyComponent`).'
    );
  }
  const analyze = memoizedAnalyze();
  const inlined = (mods: string[]): string[] =>
    mods.filter(m => Object.prototype.hasOwnProperty.call(PUBLISH_REACT_DEP_SCRIPTS, m));
  const entryReferences = await analyze(input.source);
  assertPublishableReferences(input.source, entryReferences, { allowRelativeSideEffects: true });
  if (relativeSpecifiers(input.source, entryReferences).length === 0) {
    assertPublishableReferences(input.source, entryReferences);
    const dependencies = inlined(packageImports(input.source, entryReferences));
    const transpiledCode = await transpileSingleFile(input.source, analyze);
    return { indexHtml: assembleReactBundleHtml({ title: input.title, transpiledCode, dependencies }) };
  }

  const files = input.files ?? {};
  const reached: Record<string, string> = Object.create(null);
  for (const key of await resolveFiles(input.source, files, analyze)) reached[key] = files[key];
  const sources = [input.source, ...Object.values(reached)];
  const deps = new Set<string>();
  for (const src of sources) {
    const references = await analyze(src);
    assertPublishableReferences(src, references, { allowRelativeSideEffects: true });
    packageImports(src, references).forEach(dep => deps.add(dep));
  }
  const dependencies = inlined([...deps]);
  const transpiledCode = await transpileReactModuleProgram(input.source, reached);
  return { indexHtml: assembleReactBundleHtml({ title: input.title, transpiledCode, dependencies }) };
}
