import { describe, it, expect } from 'vitest';
import {
  buildReactArtifactBundle,
  transpileReactSource,
  rewriteImportsToRequire,
  UnsupportedReactDependencyError,
  ReactArtifactTranspileError,
} from './transpileReactArtifact';
import { validateBundle, __testing } from './validateBundle';
import { PUBLISH_REACT_DEP_SCRIPTS } from '@bike4mind/common';
import { OPTIONAL_DEP_CDN } from '@client/app/utils/reactArtifactDeps';

const COUNTER = `import { useState } from 'react';
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-4">
      <span>{count}</span>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
export default Counter;`;

const INDEX_MANIFEST = [{ path: 'index.html', mimeType: 'text/html' }];

describe('transpileReactSource', () => {
  it('emits classic React.createElement with no import/export left behind', async () => {
    const out = await transpileReactSource(COUNTER);
    expect(out).toContain('React.createElement');
    expect(out).not.toMatch(/\bimport\b/);
    expect(out).not.toMatch(/\bexport\b/);
    // default export is rewritten to the local the bootstrap reads
    expect(out).toContain('__DEFAULT_EXPORT__');
  });
});

describe('buildReactArtifactBundle', () => {
  it('produces an inert bundle that trips no forbidden pattern and passes validateBundle', async () => {
    const { indexHtml } = await buildReactArtifactBundle({ source: COUNTER, title: 'Counter' });

    for (const { pattern, reason } of __testing.FORBIDDEN_INLINE_PATTERNS) {
      expect(pattern.test(indexHtml), `forbidden pattern hit: ${reason}`).toBe(false);
    }
    expect(indexHtml).toContain('React.createElement');
    // blessed React runtime is referenced, nothing from a CDN
    expect(indexHtml).toContain('/static/lib/react@18.x.js');
    expect(indexHtml).not.toContain('unpkg.com');
    expect(indexHtml).not.toContain('cdn.tailwindcss.com');

    const result = validateBundle({ indexHtml, manifest: INDEX_MANIFEST });
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('handles a mixed default+named React import (import React, { useState })', async () => {
    // The exact shape that failed on the preview: default + named import on one line.
    const src = `import React, { useState } from 'react';
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-4">
      <button onClick={() => setCount(c => c - 1)}>-</button>
      <span>{count}</span>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
export default Counter;`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'Counter' });
    expect(indexHtml).toContain('React.createElement');
    expect(indexHtml).not.toMatch(/\bimport\b/); // import line fully rewritten away
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('handles the `export { Name as default }` default-export form (no leftover export statement)', async () => {
    const src = `import { useState } from 'react';
function Counter() {
  const [count] = useState(0);
  return <div>{count}</div>;
}
export { Counter as default };`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });
    expect(indexHtml).toContain('__DEFAULT_EXPORT__ = Counter');
    expect(indexHtml).not.toMatch(/\bexport\b/); // no leftover `export {...}` to break the classic script
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('does not corrupt a literal "export default" embedded in JSX text (line-anchored unwrap)', async () => {
    const src = `import { useState } from 'react';
function Doc() {
  const [x] = useState(0);
  return <pre>{"export default Foo"}</pre>;
}
export default Doc;`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });
    expect(indexHtml).toContain('export default Foo'); // the string literal text survives
    expect(indexHtml).not.toContain('__DEFAULT_EXPORT__ = Foo'); // NOT rewritten inside the string
    expect(indexHtml).toContain('__DEFAULT_EXPORT__ = Doc'); // the real top-level export is unwrapped
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('rejects a bare side-effect import cleanly instead of blanking the page', async () => {
    const src = `import 'some-polyfill';
import { useState } from 'react';
export default function C() { const [n] = useState(0); return <div>{n}</div>; }`;
    await expect(buildReactArtifactBundle({ source: src, title: 'x' })).rejects.toBeInstanceOf(
      ReactArtifactTranspileError
    );
  });

  it('escapes a closing script tag in the source so it cannot break out of the inline script', async () => {
    const src = `function C() { return <div>{"</script><img src=x onerror=alert(1)>"}</div>; }\nexport default C;`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });
    // the raw closing-script sequence must not appear unescaped inside the bundle
    expect(indexHtml).not.toContain('</script><img');
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('rejects a not-yet-publishable dependency with a clear error', async () => {
    // `three` is not in PUBLISH_REACT_DEP_SCRIPTS (nor the in-app allowlist) - must be rejected.
    const src = `import * as THREE from 'three';\nexport default function C() { return <div>{typeof THREE}</div>; }`;
    await expect(buildReactArtifactBundle({ source: src, title: 'x' })).rejects.toBeInstanceOf(
      UnsupportedReactDependencyError
    );
  });

  it('does NOT reject a component that merely names common icon identifiers (no lucide import)', async () => {
    // Regression: the old extractReactDependencies auto-detects lucide-react from PascalCase icon
    // names, which 422'd a component simply CALLED `Settings` (Home/Bell/Star/User/...). The
    // import-only dependency scan fixes it - only actual `import ... from` modules gate the publish.
    const src = `import { useState } from 'react';
export default function Settings() {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(!open)}>Home Bell Star User Search</button>;
}`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'Settings' });
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('supports a non-hook React named import (useLayoutEffect) without ReferenceError', async () => {
    const src = `import { useLayoutEffect, useState } from 'react';
export default function C() {
  const [n] = useState(0);
  useLayoutEffect(() => {}, []);
  return <div>{n}</div>;
}`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });
    expect(indexHtml).toContain('React.createElement');
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('rejects a multi-file (relative import) artifact', async () => {
    const src = `import Foo from './foo';\nexport default function C() { return <Foo />; }`;
    await expect(buildReactArtifactBundle({ source: src, title: 'x' })).rejects.toBeInstanceOf(
      ReactArtifactTranspileError
    );
  });

  it('rejects a component with no default export', async () => {
    const src = `function C() { return <div>hi</div>; }`;
    await expect(buildReactArtifactBundle({ source: src, title: 'x' })).rejects.toBeInstanceOf(
      ReactArtifactTranspileError
    );
  });

  it('rejects when the only "export default" is inside a string (no real top-level export)', async () => {
    // Passes the lenient checkHasDefaultExport pre-check but has NO real default export - must be
    // rejected at publish, not shipped as a bundle that throws "No component found" at render.
    const src = `import { useState } from 'react';
function C() {
  const [n] = useState(0);
  return <pre>{"export default Foo"}</pre>;
}`;
    await expect(buildReactArtifactBundle({ source: src, title: 'x' })).rejects.toBeInstanceOf(
      ReactArtifactTranspileError
    );
  });
});

describe('blessed optional dependencies (PR 2)', () => {
  // dep specifier -> [self-hosted blessed path, require() global the bundle binds]
  const CASES: Array<[string, string, string]> = [
    ['recharts', '/static/lib/recharts@2.x.js', 'Recharts'],
    ['lucide-react', '/static/lib/lucide@1.x.js', 'LucideReactWrapper'],
    ['d3', '/static/lib/d3@7.x.js', 'd3'],
    ['lodash', '/static/lib/lodash@4.x.js', '_'],
    ['mathjs', '/static/lib/mathjs@11.x.js', 'math'],
    ['papaparse', '/static/lib/papaparse@5.x.js', 'Papa'],
    ['xlsx', '/static/lib/xlsx@0.18.x.js', 'XLSX'],
  ];

  it.each(CASES)(
    'blesses %s: emits the pinned script + require() mapping and passes validateBundle',
    async (dep, path, global) => {
      const src = `import Dep from '${dep}';
export default function C() { return <div>{typeof Dep}</div>; }`;
      const { indexHtml } = await buildReactArtifactBundle({ source: src, title: dep });

      expect(indexHtml).toContain(path); // blessed self-hosted UMD, not a CDN
      expect(indexHtml).toContain(`"${dep}":window.${global}`); // wired into the require() moduleMap
      expect(indexHtml).not.toContain('unpkg.com');

      const result = validateBundle({ indexHtml, manifest: INDEX_MANIFEST });
      expect(result.violations).toEqual([]);
      expect(result.valid).toBe(true);
    }
  );

  it('loads dep UMDs AFTER the React runtime (recharts externalizes React/PropTypes)', async () => {
    const src = `import { LineChart } from 'recharts';
export default function C() { return <LineChart />; }`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });
    // prop-types must be present and precede recharts, or recharts' UMD factory throws at init.
    expect(indexHtml.indexOf('/static/lib/prop-types@15.x.js')).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf('/static/lib/prop-types@15.x.js')).toBeLessThan(
      indexHtml.indexOf('/static/lib/recharts@2.x.js')
    );
  });

  it('embeds the LucideReactWrapper shim only when lucide-react is imported', async () => {
    const withLucide = await buildReactArtifactBundle({
      source: `import { Home } from 'lucide-react';\nexport default function C() { return <Home />; }`,
      title: 'x',
    });
    expect(withLucide.indexHtml).toContain('setupLucideWrapper()');

    const withoutLucide = await buildReactArtifactBundle({ source: COUNTER, title: 'x' });
    expect(withoutLucide.indexHtml).not.toContain('setupLucideWrapper');
  });

  it('renders lucide icons from the node-array format, not dangerouslySetInnerHTML', async () => {
    // lucide@1.x exposes icons as node arrays ([tag, attrs][]); the shim must build real SVG
    // children via React.createElement. Guards against a regression back to the string-injection
    // form (which rendered invisible icons). The shim lives in a template string, so assert on it.
    const { indexHtml } = await buildReactArtifactBundle({
      source: `import { Home } from 'lucide-react';\nexport default function C() { return <Home />; }`,
      title: 'x',
    });
    expect(indexHtml).toContain('Array.isArray');
    expect(indexHtml).toContain('React.createElement(entry[0]');
    expect(indexHtml).not.toContain('dangerouslySetInnerHTML');
  });

  it('handles an artifact importing multiple blessed deps at once', async () => {
    const src = `import { LineChart } from 'recharts';
import _ from 'lodash';
export default function C() { return <LineChart data={_.range(3)} />; }`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });
    expect(indexHtml).toContain('/static/lib/recharts@2.x.js');
    expect(indexHtml).toContain('/static/lib/lodash@4.x.js');
    expect(indexHtml).toContain('"recharts":window.Recharts');
    expect(indexHtml).toContain('"lodash":window._');
    expect(validateBundle({ indexHtml, manifest: INDEX_MANIFEST }).valid).toBe(true);
  });

  it('does not emit any dep script for a dependency-free artifact', async () => {
    const { indexHtml } = await buildReactArtifactBundle({ source: COUNTER, title: 'x' });
    for (const [, path] of CASES) {
      expect(indexHtml).not.toContain(path);
    }
  });

  it('rejects an Object.prototype key as a dependency (hasOwnProperty, not `in`)', async () => {
    // `constructor` is on Object.prototype, so a naive `in` check would treat it as blessed and
    // emit an undefined script path/global. It must be rejected like any unsupported module.
    const src = `import constructor from 'constructor';
export default function C() { return <div>{typeof constructor}</div>; }`;
    await expect(buildReactArtifactBundle({ source: src, title: 'x' })).rejects.toBeInstanceOf(
      UnsupportedReactDependencyError
    );
  });
});

describe('registry parity: OPTIONAL_DEP_CDN (in-app) vs PUBLISH_REACT_DEP_SCRIPTS (publish)', () => {
  // The two registries must agree so a published artifact resolves the same globals as the in-chat
  // preview. Guards against a silent one-sided edit (previously only enforced by a comment).
  it('covers the same optional dependency keys', () => {
    const publishKeys = Object.keys(PUBLISH_REACT_DEP_SCRIPTS).sort();
    // react is a base runtime script in-app (not in OPTIONAL_DEP_CDN), so compare the optional set.
    const inAppKeys = Object.keys(OPTIONAL_DEP_CDN).sort();
    expect(publishKeys).toEqual(inAppKeys);
  });

  it('maps each dependency to the same window global on both paths', () => {
    for (const [dep, { global }] of Object.entries(PUBLISH_REACT_DEP_SCRIPTS)) {
      expect(OPTIONAL_DEP_CDN[dep]?.globalVar, `global mismatch for "${dep}"`).toBe(global);
    }
  });

  it('pins the same major version on both paths (publish path major covers the in-app exact version)', () => {
    // The publish path pins a MAJOR (`recharts@2.x.js`, `xlsx@0.18.x.js` since 0.x is unstable); the
    // in-app CDN url pins an EXACT version (`recharts@2.8.0`). They must share that major so a
    // published artifact loads the same major-version UMD it previewed against.
    for (const [dep, { path }] of Object.entries(PUBLISH_REACT_DEP_SCRIPTS)) {
      const publishMajor = path.match(/@(\d[\d.]*)\.x\.js$/)?.[1];
      const cdnVersion = OPTIONAL_DEP_CDN[dep]?.url.match(/@(\d[\d.]*)\//)?.[1];
      expect(publishMajor, `no major-version token in publish path for "${dep}"`).toBeTruthy();
      expect(cdnVersion, `no version in in-app CDN url for "${dep}"`).toBeTruthy();
      expect(
        cdnVersion === publishMajor || cdnVersion!.startsWith(`${publishMajor}.`),
        `version mismatch for "${dep}": in-app ${cdnVersion} vs publish ${publishMajor}.x`
      ).toBe(true);
    }
  });

  it('pins the mathjs in-app CDN to the unminified browser build (lib/browser/math.js, not .min.js)', () => {
    // mathjs 11.x ships NO minified browser UMD - the `.min.js` path 404s and every mathjs preview
    // fails to load. Locks the fix for that regression (the self-hosted publish copy matches).
    expect(OPTIONAL_DEP_CDN.mathjs.url).toContain('/lib/browser/math.js');
    expect(OPTIONAL_DEP_CDN.mathjs.url).not.toContain('math.min.js');
  });
});

describe('rewriteImportsToRequire', () => {
  it('binds a non-hook named React import from React; already-global hooks are not re-declared', () => {
    const out = rewriteImportsToRequire(`import { useLayoutEffect, useState } from 'react';`);
    expect(out).toContain('const { useLayoutEffect } = React');
    expect(out).not.toContain('useState ='); // useState is a bootstrap global; must not be re-bound
  });

  it('drops a default-only React import (React is a runtime global)', () => {
    const out = rewriteImportsToRequire(`import React from 'react';`);
    expect(out).not.toContain("require('react')");
    expect(out).toContain('react is a runtime global');
  });

  it('does not conflate adjacent semicolon-less imports', () => {
    const out = rewriteImportsToRequire(`import Chart from 'chartjs'\nimport Grid from 'gridjs';`);
    expect(out).toContain(`const Chart = require('chartjs');`);
    expect(out).toContain(`const Grid = require('gridjs');`);
    expect(out).not.toMatch(/from '[^']+'\s+import/); // no greedy `... from 'x' import ...` garbage
  });

  it('splits a mixed default+named non-react import into valid statements', () => {
    const out = rewriteImportsToRequire(`import LineChart, { BarChart } from 'recharts';`);
    expect(out).toContain(`const LineChart = require('recharts');`);
    expect(out).toContain(`const { BarChart } = LineChart;`);
    expect(out).not.toContain('const LineChart, {'); // the previously-emitted invalid destructuring
  });

  it('rewrites a namespace import to a single require (import * as d3 -> require)', () => {
    const out = rewriteImportsToRequire(`import * as d3 from 'd3';`);
    expect(out).toContain(`const d3 = require('d3');`);
    expect(out).not.toContain('* as'); // no leftover invalid `const * as d3 = require('d3')`
  });
});
