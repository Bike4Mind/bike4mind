import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  buildReactArtifactBundle,
  findRelativeModuleReferences,
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

describe('multi-file default-export forms', () => {
  const forms: [string, string, Record<string, string>][] = [
    [
      'export { X as default }',
      `import Stopwatch from './Stopwatch';\nfunction App() { return <main><Stopwatch /></main>; }\nexport { App as default };`,
      { Stopwatch: STOPWATCH },
    ],
    [
      'export { Widget as default } from a sibling',
      `export { Widget as default } from './Page';`,
      { Page: `export function Widget() { return <p>page</p>; }` },
    ],
  ];
  for (const [label, source, files] of forms) {
    it(`accepts ${label}`, async () => {
      const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App', files });
      expect(validateBundle({ indexHtml, manifest: [{ path: 'index.html', mimeType: 'text/html' }] }).valid).toBe(true);
    });
  }
});

describe('multi-file side-effect imports', () => {
  const entry = `import './Setup';\nexport default function App() { return <b>x</b>; }`;

  it('accepts a relative side-effect import of a sibling', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: entry,
      title: 'App',
      files: { Setup: `globalThis.__setup = 1;` },
    });
    expect(indexHtml).toContain('"Setup"');
  });

  it('rejects a relative side-effect import with no matching file', async () => {
    await expect(
      buildReactArtifactBundle({ source: entry, title: 'App', files: { Other: STOPWATCH } })
    ).rejects.toThrow('Cannot resolve "./Setup"');
  });

  it('rejects a relative side-effect import when there are no files', async () => {
    await expect(buildReactArtifactBundle({ source: entry, title: 'App' })).rejects.toThrow('Cannot resolve "./Setup"');
  });

  it('still rejects a bare package side-effect import in the entry or a sibling', async () => {
    await expect(
      buildReactArtifactBundle({
        source: `import 'lodash';\nimport S from './Stopwatch';\nexport default function A() { return <S />; }`,
        title: 'App',
        files: { Stopwatch: STOPWATCH },
      })
    ).rejects.toThrow('Side-effect imports');
    await expect(
      buildReactArtifactBundle({
        source: ENTRY,
        title: 'App',
        files: { Stopwatch: `import 'lodash';\n${STOPWATCH}` },
      })
    ).rejects.toThrow('Side-effect imports');
  });
});

describe('resolveReactArtifactFiles', () => {
  it('walks sibling-to-sibling imports transitively, in files order, through cycles', async () => {
    const files = {
      C: `import A from './A';`,
      A: `import B from '../lib/b.jsx';`,
      B: `export { x } from './C';`,
      D: 'unreached',
    };
    await expect(resolveReactArtifactFiles(`import A from './A';`, files)).resolves.toEqual(['C', 'A', 'B']);
  });

  it('ignores type-only relative imports', async () => {
    await expect(resolveReactArtifactFiles(`import type T from './types';`, {})).resolves.toEqual([]);
  });
});

// The preview only resolves the require() calls Babel emits for real imports, so publish must not
// treat a relative path that only appears in a comment or a string as a sibling file.
const COMMENT_ONLY = `import { useState } from 'react';

// ============================================================
// Counter.jsx  (kept here since artifacts can't have sibling files -
// relative imports like \`import Counter from "./Counter"\` are blocked
// by the sandbox. This section is written exactly as it would be.
// ============================================================
function Counter() {
  const [n] = useState(3);
  return <span>{n}</span>;
}

function App() {
  return <main><Counter /></main>;
}

export default App;`;

describe('relative paths outside import statements', () => {
  const app = (body: string) => `${body}\nexport default function App() { return <p>{label}</p>; }`;

  it.each([
    ['a line comment', COMMENT_ONLY],
    ['a block comment', app(`/* import X from './X' */\nconst label = 'x';`)],
    ['a multi-line block comment', app(`/*\n * import X from './X';\n * import './side';\n */\nconst label = 'x';`)],
    ['a string literal', app(`const label = "import X from './X'";`)],
    ['a single-quoted string', app(`const label = 'import X from "./X"';`)],
    ['a template literal', app("const label = `import X from './X'; require('./Y')`;")],
    ['JSX text', `export default function App() { return <p>import X from './X'</p>; }`],
  ])('publishes a single file whose only relative path is in %s', async (_label, source) => {
    await expect(findRelativeModuleReferences(source)).resolves.toEqual([]);
    const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App' });
    expect(validateBundle({ indexHtml, manifest: [{ path: 'index.html', mimeType: 'text/html' }] }).valid).toBe(true);
    expect(indexHtml).not.toContain('.run(');
    expect(renderInert(indexHtml)).not.toMatch(/^Error/);
  });

  it('keeps the mentioned text verbatim in the published script', async () => {
    const source = app(`const label = 'import X from "./X"';`);
    const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App' });
    expect(inlineBootstrap(indexHtml)).toContain(`'import X from "./X"'`);
  });

  it('still rejects a real relative import with no sibling, with the same message', async () => {
    await expect(
      buildReactArtifactBundle({
        source: `import Counter from './Counter';\nexport default function App() { return <Counter />; }`,
        title: 'App',
      })
    ).rejects.toThrow('Cannot resolve "./Counter": no artifact file is named "counter". Available files: none.');
  });

  it('resolves only the real import when a commented one sits next to it', async () => {
    const source = `// import Gone from './Gone';
import Stopwatch from './Stopwatch';
/* export { x } from './AlsoGone'; */
export default function App() { return <main><Stopwatch /></main>; }`;
    await expect(resolveReactArtifactFiles(source, { Stopwatch: STOPWATCH })).resolves.toEqual(['Stopwatch']);
    const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App', files: { Stopwatch: STOPWATCH } });
    expect(renderInert(indexHtml)).toBe('<main><span>7</span></main>');
  });

  it('finds every real relative form, in source order, once each', async () => {
    const source = `import A from './A';
import './side';
export { b } from '../lib/b';
export * from './c';
const d = require('./d');
const e = import('./e');
import type T from './types';
import { type U } from './u';
import A2 from './A';
export default function App() { return null; }`;
    await expect(findRelativeModuleReferences(source)).resolves.toEqual([
      './A',
      './side',
      '../lib/b',
      './c',
      './d',
      './e',
    ]);
  });
});
