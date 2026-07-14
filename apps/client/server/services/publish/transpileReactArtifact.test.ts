import { describe, it, expect } from 'vitest';
import {
  buildReactArtifactBundle,
  transpileReactSource,
  rewriteImportsToRequire,
  UnsupportedReactDependencyError,
  ReactArtifactTranspileError,
} from './transpileReactArtifact';
import { validateBundle, __testing } from './validateBundle';

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
    const src = `import { LineChart } from 'recharts';\nexport default function C() { return <LineChart />; }`;
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
});
