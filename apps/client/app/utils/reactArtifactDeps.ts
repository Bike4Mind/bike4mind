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
 * wraps it as `window.LucideReactWrapper` (see LUCIDE_WRAPPER_SETUP in the route).
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
