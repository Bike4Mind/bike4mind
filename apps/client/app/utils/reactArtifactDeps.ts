/**
 * Single source of truth for the dependencies a React artifact may import.
 *
 * Consumed by the sandbox route (apps/client/pages/api/react-artifact-sandbox.ts)
 * to build the in-iframe runtime, and reserved for the milestone-3 on-demand
 * compiler so the two can never drift. Keep this a pure, React-free data
 * module - it is imported by a Next.js API route.
 */

/** Dependencies a React artifact is allowed to `import` (matches Claude's artifact constraints). */
export const ALLOWED_DEPENDENCIES = [
  'react',
  'lucide-react',
  'recharts',
  'mathjs',
  'lodash',
  'd3',
  'papaparse',
  'xlsx',
] as const;

/**
 * Optional dependencies (everything except `react`, which is always loaded as a base
 * script). `url` is the CDN script the sandbox injects on demand; `globalVar` is the
 * `window` global it exposes, used to build the `require()` module map inside the sandbox.
 * `lucide-react` is special - loading its CDN script exposes `lucide`, and the sandbox then
 * wraps it as `window.LucideReactWrapper` (see LUCIDE_WRAPPER_FN below).
 */
export const OPTIONAL_DEP_CDN: Record<string, { url: string; globalVar: string }> = {
  'lucide-react': { url: 'https://unpkg.com/lucide@1.21.0/dist/umd/lucide.min.js', globalVar: 'LucideReactWrapper' },
  recharts: { url: 'https://unpkg.com/recharts@2.8.0/umd/Recharts.js', globalVar: 'Recharts' },
  // mathjs 11.x ships only the UNMINIFIED browser UMD (lib/browser/math.js); the `.min.js` path
  // 404s on the CDN. Must stay in sync with the self-hosted publish copy (mathjs@11.x.js).
  mathjs: { url: 'https://unpkg.com/mathjs@11.11.0/lib/browser/math.js', globalVar: 'math' },
  lodash: { url: 'https://unpkg.com/lodash@4.17.21/lodash.min.js', globalVar: '_' },
  d3: { url: 'https://unpkg.com/d3@7.8.5/dist/d3.min.js', globalVar: 'd3' },
  papaparse: { url: 'https://unpkg.com/papaparse@5.4.1/papaparse.min.js', globalVar: 'Papa' },
  xlsx: { url: 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js', globalVar: 'XLSX' },
};

/** Scripts always loaded in the sandbox <head> before any artifact renders. */
export const BASE_SANDBOX_SCRIPTS = [
  // Production UMD builds (smaller/faster than dev) - artifact runtime errors are caught and
  // surfaced by the sandbox, so React's dev warnings aren't needed. Versions PINNED (not
  // @latest/unversioned) so a CDN release can't silently break every artifact fleet-wide.
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  // prop-types is a BASE script, not an optional dep: React 18's UMD dropped the bundled
  // PropTypes global, but recharts' UMD (and other React UMD libs) externalize prop-types and
  // its global-export branch is `t.Recharts = factory(t.React, t.PropTypes, t.ReactDOM)`. With
  // PropTypes undefined the factory throws at init, `window.Recharts` is never assigned, and
  // the sandbox's require() reports `Module "recharts" is not available`.
  'https://unpkg.com/prop-types@15.8.1/prop-types.min.js',
  'https://unpkg.com/@babel/standalone@8.0.3/babel.min.js',
  'https://cdn.tailwindcss.com',
] as const;

/** CDN hosts the sandbox CSP must allow in `script-src` (base scripts + optional deps). */
export const SANDBOX_SCRIPT_HOSTS = ['https://unpkg.com', 'https://cdn.tailwindcss.com'] as const;

/**
 * Source TEXT for the `window.LucideReactWrapper` factory, shared by BOTH surfaces that render a
 * lucide artifact: the in-app sandbox (react-artifact-sandbox.ts) and the publish assembler
 * (transpileReactArtifact.ts LUCIDE_WRAPPER_SETUP). Single source of truth so a published lucide
 * artifact renders identically to its chat preview - a prior drift here shipped invisible icons.
 *
 * It is a string (embedded verbatim into each surface's inline <script>), not a live function,
 * because the two run in different execution contexts. It DEFINES `setupLucideWrapper()` but does
 * not call it; each caller invokes it only when the artifact imports lucide-react.
 *
 * Constraints (both surfaces embed it in a template-literal <script>): no backtick, and no literal
 * closing-script-tag sequence (would truncate the inline script). It also has no regex backslash,
 * so it needs no escape-doubling when interpolated into the sandbox's SANDBOX_HTML template.
 */
export const LUCIDE_WRAPPER_FN = `function setupLucideWrapper() {
  if (window.LucideReactWrapper) return;
  var toKebabCase = function (str) { return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(); };
  window.LucideReactWrapper = new Proxy({}, {
    get: function (target, iconName) {
      return function (props) {
        props = props || {};
        var size = props.size || 24;
        var color = props.color || 'currentColor';
        var strokeWidth = props.strokeWidth || 2;
        var className = props.className || '';
        // Preserve pass-through props (onClick, aria-*, data-*, style, ...) like lucide-react.
        var rest = Object.assign({}, props);
        delete rest.size; delete rest.color; delete rest.strokeWidth; delete rest.className;
        var kebab = toKebabCase(iconName);
        // lucide's UMD stores each icon as a node array ([tag, attrs][]), NOT an HTML string -
        // build real SVG children from it (injecting the array as innerHTML renders nothing).
        var node = (window.lucide && lucide.icons && (lucide.icons[iconName] || lucide.icons[kebab])) || null;
        var children = Array.isArray(node)
          ? node.map(function (entry, i) { return React.createElement(entry[0], Object.assign({ key: i }, entry[1])); })
          : null;
        return React.createElement('svg', Object.assign({
          xmlns: 'http://www.w3.org/2000/svg', width: size, height: size, viewBox: '0 0 24 24',
          fill: 'none', stroke: color, strokeWidth: strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
          className: className
        }, rest), children);
      };
    }
  });
}`;
