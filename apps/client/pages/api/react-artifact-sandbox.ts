import type { NextApiRequest, NextApiResponse } from 'next';
import {
  ALLOWED_DEPENDENCIES,
  OPTIONAL_DEP_CDN,
  BASE_SANDBOX_SCRIPTS,
  SANDBOX_SCRIPT_HOSTS,
  LUCIDE_WRAPPER_FN,
} from '@client/app/utils/reactArtifactDeps';

/**
 * GET /api/react-artifact-sandbox - iframe target for client-rendered REACT artifacts.
 *
 * Why this is an API route (sibling of /api/artifact-sandbox): files under `public/`
 * are served by the CloudFront S3 origin and never reach the Next.js Lambda, so the
 * global `proxy.ts` CSP cannot be set on them - and, critically, the OLD approach loaded
 * React artifacts from a `blob:` URL, which per the Chromium spec INHERITS the creating
 * document's CSP and can only restrict it further. In prod the app CSP has no
 * `'unsafe-eval'`, so the blob's inline `<meta>` CSP could not re-grant it and
 * Babel.transform()/new Function() were blocked.
 *
 * Routing through `/api/*` forces the request through the Lambda, so THIS handler sets
 * an authoritative `Content-Security-Policy` RESPONSE HEADER that includes `'unsafe-eval'`
 * - scoped to this one route. The app-origin CSP (`proxy.ts`) is never touched and keeps
 * NO `'unsafe-eval'` in prod, so a future app-CSP hardening pass cannot silently break
 * artifacts again. `connect-src 'none'` blocks exfiltration from inside the sandbox.
 *
 * The iframe runs `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so the eval'd
 * artifact code executes in an OPAQUE origin and cannot read app cookies/localStorage/
 * tokens - identical isolation to the old blob: iframe, but with a working CSP.
 *
 * Per-artifact code + dependencies are delivered via postMessage (never string-baked into
 * the document): the parent sends `{ type: 'react-artifact-render', code, dependencies }`
 * after receiving `react-sandbox-ready`. Errors are posted back as
 * `{ type: 'react-sandbox-error', message }`.
 *
 * NOTE: this route still relies on in-browser eval (Babel + new Function). Milestone 3
 * moves transpilation to an on-demand server endpoint and drops `'unsafe-eval'`
 * from the header below - a route-internal change touching nothing else.
 */

const REACT_SANDBOX_CSP = [
  "default-src 'none'",
  // 'unsafe-eval' lives HERE and only here - never on the app origin (proxy.ts).
  `script-src 'unsafe-inline' 'unsafe-eval' ${SANDBOX_SCRIPT_HOSTS.join(' ')} blob:`,
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https://fonts.gstatic.com https://fonts.googleapis.com',
  "connect-src 'none'",
  'media-src blob: data:',
  'worker-src blob:',
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const BASE_SCRIPT_TAGS = BASE_SANDBOX_SCRIPTS.map(src => `<script src="${src}"></script>`).join('\n  ');

/**
 * The static sandbox shell. Loads base libs (React/ReactDOM/Babel/Tailwind), then waits
 * for a render message. Optional deps are lazy-loaded on demand so a low-dependency
 * artifact (e.g. a Stopwatch) does not pull multi-MB of unused UMD bundles.
 *
 * Regex backslashes are doubled (`\\s`) because this string is a template literal whose
 * content becomes the literal script source. The body avoids inner template literals to
 * keep the escaping tractable.
 *
 * FOOTGUN: never write the literal sequence `</script>` anywhere in this template -
 * not even inside a JS comment or string. The HTML tokenizer is in script-data state for the
 * whole inline <script> block and exits on the FIRST `</script>` it sees, truncating the
 * script and dumping the rest as body text. A backslash escape does NOT help: a template
 * literal collapses `<\/script>` back to `</script>` before it reaches the browser. If you
 * must reference a closing script tag, reword it ("closing script tag") or split it
 * ('</scr' + 'ipt>'). Enforced by react-artifact-sandbox.test.ts.
 */
const SANDBOX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>React Artifact</title>
  <style>
    html, body { margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif; background: white; min-height: 100vh; }
    * { box-sizing: border-box; }
    .error { color: #b91c1c; background: #fee2e2; padding: 12px; border-radius: 4px; border-left: 4px solid #b91c1c; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
  </style>
  ${BASE_SCRIPT_TAGS}
  <script>if (window.tailwind) { tailwind.config = { darkMode: 'class' }; }</script>
</head>
<body>
  <div id="root"></div>
  <script>
    var ALLOWED = ${JSON.stringify(ALLOWED_DEPENDENCIES)};
    var OPTIONAL_DEPS = ${JSON.stringify(OPTIONAL_DEP_CDN)};
    var rootEl = document.getElementById('root');

    function showError(msg) {
      // textContent (not innerHTML) so an error message containing markup can't corrupt the
      // error UI or inject elements (self-XSS only given the opaque origin, but more robust).
      rootEl.innerHTML = '';
      var box = document.createElement('div');
      box.className = 'error';
      var label = document.createElement('strong');
      label.textContent = 'Error: ';
      box.appendChild(label);
      box.appendChild(document.createTextNode(String(msg)));
      rootEl.appendChild(box);
    }
    function postError(message, stack) {
      window.parent.postMessage({ type: 'react-sandbox-error', message: String(message), stack: stack || '' }, '*');
    }
    window.addEventListener('error', function (event) {
      var m = (event.error && event.error.message) || event.message;
      showError(m);
      postError(m, event.error && event.error.stack);
    });

    var loaded = {};
    function loadScript(url) {
      return new Promise(function (resolve, reject) {
        if (loaded[url]) return resolve();
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () { loaded[url] = true; resolve(); };
        s.onerror = function () { reject(new Error('Failed to load ' + url)); };
        document.head.appendChild(s);
      });
    }

    // window.LucideReactWrapper factory - shared source with the publish assembler (see
    // LUCIDE_WRAPPER_FN in reactArtifactDeps.ts) so preview and published output stay identical.
    ${LUCIDE_WRAPPER_FN}

    function renderArtifact(code, dependencies, mode) {
      // Multi-file artifacts aren't supported yet (#9403 follow-up): the require() shim below
      // resolves only npm packages, not sibling artifact files. Detect a relative import up
      // front and show a clear message instead of a cryptic "Cannot use import statement" /
      // "Module not available" further down.
      // Catch every relative-reference form: import-from, export-from, side-effect import,
      // and require() of a "./" or "../" path — all unresolvable by the npm-only shim below.
      var relImport =
        code.match(/(?:import|export)\\b[^;'"]*\\bfrom\\s*['"](\\.\\.?\\/[^'"]+)['"]/) ||
        code.match(/\\bimport\\s*['"](\\.\\.?\\/[^'"]+)['"]/) ||
        code.match(/\\brequire\\(\\s*['"](\\.\\.?\\/[^'"]+)['"]\\s*\\)/);
      if (relImport) {
        var msg = 'Multi-file artifacts are not supported yet — this one references "' + relImport[1] +
          '" from a separate file. Ask for a single, self-contained component (one file, one default export).';
        showError(msg);
        postError(msg);
        return;
      }
      var deps = (dependencies || []).filter(function (d) { return ALLOWED.indexOf(d) !== -1; });
      var loads = [];
      deps.forEach(function (d) { var meta = OPTIONAL_DEPS[d]; if (meta) loads.push(loadScript(meta.url)); });

      Promise.all(loads).then(function () {
        if (deps.indexOf('lucide-react') !== -1) setupLucideWrapper();

        var moduleMap = { 'react': React };
        deps.forEach(function (d) { var meta = OPTIONAL_DEPS[d]; if (meta) moduleMap[d] = window[meta.globalVar]; });
        var require = function (module) {
          // hasOwnProperty (not a truthy check): a plain-object moduleMap inherits Object.prototype,
          // so \`moduleMap['toString']\` etc. would resolve to a prototype method instead of throwing.
          if (Object.prototype.hasOwnProperty.call(moduleMap, module)) return moduleMap[module];
          throw new Error('Module "' + module + '" is not available');
        };

        // Normalize ESM "X as Y" renames to valid destructuring "X: Y" (a raw { X as Y } in a
        // const-destructure is a syntax error). Kept in sync with the publish transpiler.
        var renameNamed = function (clause) { return clause.replace(/(\\w+)\\s+as\\s+(\\w+)/g, '$1: $2'); };
        var transformedCode = code.replace(/import\\s+([\\s\\S]*?)\\s+from\\s+['"]([^'"]+)['"]/g, function (match, imports, module) {
          if (module === 'react') return '// React is global';
          if (imports.trim().match(/^\\w+$/)) return 'const ' + imports.trim() + " = require('" + module + "');";
          // Namespace import (import * as d3 from 'd3') -> const d3 = require('d3'). Without this it
          // would emit an invalid \`const * as d3 = require(...)\` (matches the publish transpiler).
          var ns = imports.trim().match(/^\\*\\s+as\\s+(\\w+)$/);
          if (ns) return 'const ' + ns[1] + " = require('" + module + "');";
          // Mixed default + named (import Foo, { bar } from 'mod') -> bind default, then destructure
          // the named off it; otherwise the fallback emits invalid \`const Foo, { bar } = require()\`.
          var mixed = imports.trim().match(/^(\\w+)\\s*,\\s*(\\{[\\s\\S]*\\})$/);
          if (mixed) return 'const ' + mixed[1] + " = require('" + module + "'); const " + renameNamed(mixed[2]) + ' = ' + mixed[1] + ';';
          return 'const ' + renameNamed(imports) + " = require('" + module + "');";
        });

        var R = React;
        var useState = R.useState, useEffect = R.useEffect, useRef = R.useRef, useMemo = R.useMemo,
            useCallback = R.useCallback, useReducer = R.useReducer, useContext = R.useContext, createContext = R.createContext;

        var processedCode;
        try {
          // Pin the CLASSIC JSX runtime (React.createElement). @babel/standalone 8.x
          // defaults preset-react to the AUTOMATIC runtime, which INJECTS
          // \`import { jsx as _jsx } from "react/jsx-runtime"\` at the top of the output —
          // fatal here: the sandbox runs the transformed code as a classic <script> /
          // new Function with React as a GLOBAL (no module loader), so a top-level import
          // throws "Cannot use import statement outside a module" and nothing renders. The
          // classic runtime emits React.createElement, which resolves against the in-scope
          // React global. (#9506 follow-up — surfaced once #9539 fixed the script truncation.)
          processedCode = Babel.transform(transformedCode, {
            presets: [['react', { runtime: 'classic' }]],
            filename: 'component.jsx',
          }).code;
        } catch (e) {
          processedCode = transformedCode;
          if (processedCode.indexOf('<') !== -1 && processedCode.indexOf('>') !== -1) {
            throw new Error('JSX transformation failed. Use React.createElement() syntax.');
          }
        }

        // Unwrap the default export into the local the render reads. Handle BOTH forms that
        // checkHasDefaultExport accepts - \`export default X\` and \`export { X as default }\` - so the
        // preview stays in parity with publish (transpileReactArtifact.ts does the same); otherwise
        // the \`export { ... }\` survives into this classic script as a parse error and blanks #root.
        var codeWithoutExports = processedCode
          .replace(/export\\s+default\\s+/g, 'const __DEFAULT_EXPORT__ = ')
          .replace(/export\\s*\\{\\s*([A-Za-z_$][\\w$]*)\\s+as\\s+default\\s*\\}/g, 'const __DEFAULT_EXPORT__ = $1');

        if (mode === 'inert') {
          // Eval-free execution (#9403 M3): Babel.transform above only PARSES + GENERATES code
          // (no eval), so the only eval was the new Function() below. Here we instead run the
          // already-transformed code as an injected inline <script> — governed by
          // script-src 'unsafe-inline', NOT 'unsafe-eval'. textContent (not innerHTML) so a
          // closing script tag in user code can't break out. require/root reach the script via
          // globals, which the IIFE captures into locals and immediately deletes — no globals
          // linger after render. When the flag is on, the route header can drop 'unsafe-eval'.
          window.__artifactRequire = require;
          window.__artifactRoot = rootEl;
          var hooks = 'var useState=React.useState,useEffect=React.useEffect,useRef=React.useRef,useMemo=React.useMemo,useCallback=React.useCallback,useReducer=React.useReducer,useContext=React.useContext,createContext=React.createContext;';
          var inertSource = '(function(){var React=window.React;' + hooks + 'var require=window.__artifactRequire;var root=window.__artifactRoot;delete window.__artifactRequire;delete window.__artifactRoot;' + codeWithoutExports + ';var __c=(typeof __DEFAULT_EXPORT__!=="undefined")?__DEFAULT_EXPORT__:null;if(!__c){throw new Error("No component found");}ReactDOM.createRoot(root).render(React.createElement(__c));})();';
          var inertScript = document.createElement('script');
          inertScript.textContent = inertSource;
          document.body.appendChild(inertScript);
          return;
        }

        var functionBody = codeWithoutExports + "; if (typeof __DEFAULT_EXPORT__ !== 'undefined') return __DEFAULT_EXPORT__; throw new Error('No component found');";
        var ComponentFactory = new Function('React', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useReducer', 'useContext', 'createContext', 'require', functionBody);
        var Component = ComponentFactory.call({}, R, useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, require);
        ReactDOM.createRoot(rootEl).render(React.createElement(Component));
      }).catch(function (error) {
        showError(error.message);
        postError(error.message, error.stack);
      });
    }

    var rendered = false;
    function handleRenderMessage(event) {
      // Opaque origin (no allow-same-origin): event.source === window.parent is sufficient
      // provenance; targetOrigin cannot be checked. One render per iframe instance — the
      // parent remounts the iframe (key bump) to re-render on edit.
      if (event.source !== window.parent) return;
      if (!event.data || event.data.type !== 'react-artifact-render') return;
      if (rendered) return;
      rendered = true;
      try { renderArtifact(event.data.code, event.data.dependencies || [], event.data.mode); }
      catch (error) { showError(error.message); postError(error.message, error.stack); }
    }
    window.addEventListener('message', handleRenderMessage);
    window.parent.postMessage({ type: 'react-sandbox-ready' }, '*');
  </script>
</body>
</html>`;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end('Method Not Allowed');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', REACT_SANDBOX_CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Static shell - the parent supplies artifact code via postMessage after load.
  // Trade-off (matches /api/artifact-sandbox): a CSP change here takes up to 5 minutes to
  // propagate through CDN/browser caches. Milestone 3 (dropping 'unsafe-eval') should pair
  // the header change with a cache bust.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  return res.status(200).send(req.method === 'HEAD' ? '' : SANDBOX_HTML);
}
