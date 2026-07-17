import { REACT_BLESSED_SCRIPT_PATHS, PUBLISH_REACT_DEP_SCRIPTS } from '@bike4mind/common';
import { checkHasDefaultExport } from '@client/app/utils/artifactParser';
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

// Any relative reference (import/export-from, side-effect import, require) points at a sibling
// file the single-file bundle can't resolve - reject like the in-app sandbox does.
const REL_IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:import|export)\b[^;'"]*\bfrom\s*['"](\.\.?\/[^'"]+)['"]/,
  /\bimport\s*['"](\.\.?\/[^'"]+)['"]/,
  /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/,
];

function findRelativeImport(source: string): string | null {
  for (const pattern of REL_IMPORT_PATTERNS) {
    const m = source.match(pattern);
    if (m) return m[1];
  }
  return null;
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
 * Uses lazy `[\s\S]*?` (not greedy `[^;]+`) so adjacent semicolon-less imports (valid via ASI) are
 * not conflated into one broken match. Exported for unit tests.
 */
export function rewriteImportsToRequire(source: string): string {
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
  return source.replace(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g, (_match, clauseRaw: string, mod: string) => {
    const clause = clauseRaw.trim();
    const namedMatch = clause.match(/\{([\s\S]*)\}/);
    const namedRaw = namedMatch ? namedMatch[1].trim() : '';
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
}

/** Module specifiers from real `import ... from '...'` statements (non-relative only). */
function extractImportedModules(source: string): string[] {
  const mods = new Set<string>();
  const re = /import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const mod = m[1];
    if (!mod.startsWith('.') && !mod.startsWith('/')) mods.add(mod);
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
  if (/^\s*import\s+['"]/m.test(source)) {
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
 * JSX -> inert classic-runtime JS. Rewrites imports, transpiles JSX to `React.createElement`
 * via @babel/standalone, then unwraps `export default` into a `__DEFAULT_EXPORT__` local the
 * bootstrap reads. Output contains no import/export statements and no eval.
 */
export async function transpileReactSource(source: string): Promise<string> {
  const relImport = findRelativeImport(source);
  if (relImport) {
    throw new ReactArtifactTranspileError(
      `Multi-file artifacts are not supported: this one references "${relImport}" from a separate file. ` +
        `Provide a single self-contained component (one file, one default export).`
    );
  }

  const Babel = await getBabel();
  const withRequires = rewriteImportsToRequire(source);

  let transformed: string | null | undefined;
  try {
    // Classic runtime: emit React.createElement against the React global (the AUTOMATIC runtime
    // injects `import { jsx } from "react/jsx-runtime"`, fatal in a no-module-loader script).
    // Identical config to the in-app sandbox (react-artifact-sandbox.ts) so a published artifact
    // renders the same as the chat preview.
    transformed = Babel.transform(withRequires, {
      presets: [['react', { runtime: 'classic' }]],
      filename: 'component.jsx',
    }).code;
  } catch (e) {
    throw new ReactArtifactTranspileError(`JSX transform failed: ${(e as Error).message}`);
  }
  if (!transformed) {
    throw new ReactArtifactTranspileError('JSX transform produced no output.');
  }

  // Unwrap the default export into a local the bootstrap reads. Handle BOTH forms that
  // checkHasDefaultExport accepts - `export default X` and `export { X as default }` - because
  // Babel (preset-react only) leaves module syntax untouched, so an unhandled `export { ... }`
  // would survive into the classic inline <script> and fail to parse (silently blanking the page).
  const unwrapped = transformed
    // Anchored to line-start (`m`): Babel emits top-level exports at column 0, so this rewrites the
    // real statement but NOT a literal "export default ..." embedded in a string / JSX text.
    .replace(/^(\s*)export\s+default\s+/gm, '$1const __DEFAULT_EXPORT__ = ')
    .replace(/^\s*export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}\s*;?/gm, 'const __DEFAULT_EXPORT__ = $1;');

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
