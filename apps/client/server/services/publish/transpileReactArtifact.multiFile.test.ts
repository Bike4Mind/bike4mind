import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  buildReactArtifactBundle,
  resolveReactArtifactFiles,
  UnsupportedReactDependencyError,
  ReactArtifactTranspileError,
} from './transpileReactArtifact';
import { validateBundle } from './validateBundle';

const ENTRY = `import Stopwatch from './Stopwatch';
export default function App() { return <main><Stopwatch /></main>; }`;
const STOPWATCH = `import { useState } from 'react';
export default function Stopwatch() { const [ms] = useState(7); return <span>{ms}</span>; }`;

function inlineBootstrap(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(scripts).toHaveLength(1);
  return scripts[0];
}

/** Runs the bootstrap where string code generation is disabled, so any eval path throws. */
function renderInert(html: string): string {
  let rendered: unknown = null;
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...(props ?? {}), children },
    }),
    useState: <T>(v: T) => [v, () => undefined],
  };
  const markup = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(markup).join('');
    if (typeof node !== 'object') return String(node);
    const { type, props } = node as { type: unknown; props: Record<string, unknown> };
    if (typeof type === 'function') return markup((type as (p: unknown) => unknown)(props));
    return `<${String(type)}>${markup(props.children)}</${String(type)}>`;
  };
  const root = {
    innerHTML: '',
    textContent: '',
    appendChild: (el: { textContent: string }) => (root.textContent = el.textContent),
  };
  const window = {
    React,
    ReactDOM: { createRoot: () => ({ render: (el: unknown) => (rendered = el) }) },
  };
  const context = vm.createContext(
    {
      window,
      document: {
        getElementById: () => root,
        createElement: () => ({ textContent: '' }),
      },
    },
    { codeGeneration: { strings: false, wasm: false } }
  );
  vm.runInContext(inlineBootstrap(html), context);
  return rendered ? markup(rendered) : root.textContent;
}

describe('buildReactArtifactBundle with sibling files', () => {
  it('emits one inert inline script that passes validateBundle and renders without eval', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: ENTRY,
      title: 'App',
      files: { Stopwatch: STOPWATCH },
    });
    expect(validateBundle({ indexHtml, manifest: [{ path: 'index.html', mimeType: 'text/html' }] }).valid).toBe(true);
    expect(indexHtml).not.toMatch(/\beval\s*\(|new\s+Function/);
    expect(renderInert(indexHtml)).toBe('<main><span>7</span></main>');
  });

  it('builds an entry with no relative import exactly as a single file, ignoring files', async () => {
    const single = `export default function C() { return <p>one</p>; }`;
    const withFiles = await buildReactArtifactBundle({ source: single, title: 'x', files: { Stopwatch: STOPWATCH } });
    const without = await buildReactArtifactBundle({ source: single, title: 'x' });
    expect(withFiles.indexHtml).toBe(without.indexHtml);
  });

  it('leaves out files the entry never reaches', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: ENTRY,
      title: 'App',
      files: { Stopwatch: STOPWATCH, Unused: `export default function Unused() { return 'zzz-unused'; }` },
    });
    expect(indexHtml).toContain('"Stopwatch"');
    expect(indexHtml).not.toContain('zzz-unused');
  });

  it('rejects a missing sibling, naming the available files', async () => {
    const err = await buildReactArtifactBundle({ source: ENTRY, title: 'App', files: { Clock: STOPWATCH } }).catch(
      e => e
    );
    expect(err).toBeInstanceOf(ReactArtifactTranspileError);
    expect(err.message).toBe(
      'Cannot resolve "./Stopwatch": no artifact file is named "stopwatch". Available files: Clock.'
    );
  });

  it('rejects an import that several files match', async () => {
    await expect(
      buildReactArtifactBundle({
        source: ENTRY,
        title: 'App',
        files: { Stopwatch: STOPWATCH, 'stopwatch.jsx': STOPWATCH },
      })
    ).rejects.toThrow('files Stopwatch, stopwatch.jsx all match "stopwatch"');
  });

  it('rejects an unpublishable dependency imported only by a sibling', async () => {
    await expect(
      buildReactArtifactBundle({
        source: ENTRY,
        title: 'App',
        files: { Stopwatch: `import x from 'left-pad';\nexport default function S() { return x; }` },
      })
    ).rejects.toBeInstanceOf(UnsupportedReactDependencyError);
  });

  it('rejects a sibling that fails to transpile', async () => {
    await expect(
      buildReactArtifactBundle({ source: ENTRY, title: 'App', files: { Stopwatch: 'export default function S( {' } })
    ).rejects.toThrow(/^JSX transform failed: .*Stopwatch\.tsx/);
  });

  it('rejects a multi-file entry with no real default export', async () => {
    await expect(
      buildReactArtifactBundle({
        source: `import S from './Stopwatch';\nconst note = "export default";\nexport const App = () => <S />;`,
        title: 'App',
        files: { Stopwatch: STOPWATCH },
      })
    ).rejects.toThrow('must export a component as its default export');
  });

  it('escapes a closing script tag in a sibling source', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: ENTRY,
      title: 'App',
      files: { Stopwatch: `export default function S() { return <span>{'</script><b>'}</span>; }` },
    });
    expect(indexHtml.match(/<\/script>/g)).toHaveLength(indexHtml.match(/<script\b/g)!.length);
  });
});

describe('resolveReactArtifactFiles', () => {
  it('walks sibling-to-sibling imports transitively, in files order, through cycles', () => {
    const files = {
      C: `import A from './A';`,
      A: `import B from '../lib/b.jsx';`,
      B: `export { x } from './C';`,
      D: 'unreached',
    };
    expect(resolveReactArtifactFiles(`import A from './A';`, files)).toEqual(['C', 'A', 'B']);
  });

  it('ignores type-only relative imports', () => {
    expect(resolveReactArtifactFiles(`import type T from './types';`, {})).toEqual([]);
  });
});
