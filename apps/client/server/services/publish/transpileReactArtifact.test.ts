import { describe, it, expect } from 'vitest';
import {
  buildReactArtifactBundle,
  transpileReactSource,
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
