import { REACT_BLESSED_SCRIPT_PATHS } from '@bike4mind/common';
import { ALLOWED_DEPENDENCIES } from '@client/app/utils/reactArtifactDeps';
import { extractReactDependencies, checkHasDefaultExport } from '@client/app/utils/artifactParser';
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
 * Dependencies whose PUBLISH story exists as of this PR. `react` is the base runtime
 * (react-dom + prop-types load alongside it). The optional in-app deps (recharts, lucide-react,
 * d3, lodash, mathjs, papaparse, xlsx) render in-app but are not yet self-hosted + blessed for
 * publish - they are added in a follow-up PR. Importing a dep that is in-app-only (or unknown)
 * fails with UnsupportedReactDependencyError so the publish is rejected cleanly rather than
 * producing a broken page.
 */
export const PUBLISH_SUPPORTED_DEPENDENCIES: readonly string[] = ['react'];

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

/**
 * Rewrite `import X from 'pkg'` / `import { a, b } from 'pkg'` to `const ... = require('pkg')`
 * (react becomes a no-op since it is a runtime global). Mirrors the sandbox's rewrite so the
 * classic-runtime output can run as a plain script with no module loader.
 */
function rewriteImportsToRequire(source: string): string {
  return source.replace(/import\s+([^;]+)\s+from\s+['"]([^'"]+)['"]/g, (_match, imports: string, mod: string) => {
    if (mod === 'react') return '// react is a runtime global';
    const clause = imports.trim();
    return /^\w+$/.test(clause) ? `const ${clause} = require('${mod}');` : `const ${imports} = require('${mod}');`;
  });
}

/** Reject imports that are in-app-only or unknown; only PUBLISH_SUPPORTED_DEPENDENCIES may publish. */
export function assertPublishableDependencies(source: string): void {
  for (const dep of extractReactDependencies(source)) {
    // In ALLOWED_DEPENDENCIES but not yet publish-supported, or not an allowed dep at all:
    // either way it cannot publish yet. Message differs so authors know it's a "later" vs "never".
    if (!PUBLISH_SUPPORTED_DEPENDENCIES.includes(dep)) {
      throw new UnsupportedReactDependencyError(dep);
    }
    // Defensive: an unknown dep should already have been excluded by extractReactDependencies'
    // caller expectations, but keep the ALLOWED check explicit for auditability.
    if (!ALLOWED_DEPENDENCIES.includes(dep as (typeof ALLOWED_DEPENDENCIES)[number])) {
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

  return transformed.replace(/export\s+default\s+/g, 'const __DEFAULT_EXPORT__ = ');
}

const HOOK_GLOBALS =
  'var useState=React.useState,useEffect=React.useEffect,useRef=React.useRef,useMemo=React.useMemo,' +
  'useCallback=React.useCallback,useReducer=React.useReducer,useContext=React.useContext,createContext=React.createContext;';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Blessed React runtime `<script src>` tags. Absolute app-host form when SERVER_DOMAIN is set
 *  (so they load from the app origin even on the isolated `*.usercontent.app` serve origin);
 *  relative otherwise (local dev serves them same-origin). Both forms pass validateBundle. */
function reactRuntimeScriptTags(): string {
  return REACT_BLESSED_SCRIPT_PATHS.map(path => {
    const src = PUBLISH_HOST ? `https://${PUBLISH_HOST}${path}` : path;
    return `<script src="${src}"></script>`;
  }).join('\n');
}

/**
 * Assemble the final inert index.html: blessed React runtime scripts + a single inline bootstrap
 * that defines the hook/require globals, runs the transpiled component, and mounts it. No eval,
 * no external non-blessed scripts.
 */
export function assembleReactBundleHtml(input: { title: string; transpiledCode: string }): string {
  // A literal `</script>` inside the transpiled code (e.g. in a string literal) would close the
  // inline script early; escape it. In a JS string `<\/script>` is identical to `</script>`.
  const safeCode = input.transpiledCode.replace(/<\/(script)/gi, '<\\/$1');
  const title = escapeHtml(input.title || 'React artifact');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;padding:0}*{box-sizing:border-box}#root{min-height:100vh}.b4m-artifact-error{color:#b91c1c;background:#fee2e2;padding:12px;border-radius:4px;border-left:4px solid #b91c1c;font-family:monospace;font-size:12px;white-space:pre-wrap}</style>
${reactRuntimeScriptTags()}
</head><body>
<div id="root"></div>
<script>
(function(){
  var root=document.getElementById('root');
  function showError(msg){root.innerHTML='';var b=document.createElement('div');b.className='b4m-artifact-error';b.textContent='Error: '+String(msg);root.appendChild(b);}
  try{
    var React=window.React,ReactDOM=window.ReactDOM;
    ${HOOK_GLOBALS}
    var moduleMap={'react':React};
    var require=function(m){if(moduleMap[m])return moduleMap[m];throw new Error('Module "'+m+'" is not available');};
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
  const transpiledCode = await transpileReactSource(input.source);
  return { indexHtml: assembleReactBundleHtml({ title: input.title, transpiledCode }) };
}
