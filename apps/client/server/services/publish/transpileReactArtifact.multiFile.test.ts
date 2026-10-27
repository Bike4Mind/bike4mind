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
function renderInert(html: string, globals: Record<string, unknown> = {}): string {
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
    ...globals,
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

// Package and side-effect imports are read from the same parse as relative ones, so import text in
// a comment or a string neither 422s the publish nor inlines a UMD the page never loads.
describe('package and side-effect import text outside import statements', () => {
  const RECHARTS_PATH = '/static/lib/recharts@2.x.js';
  const app = (body: string) => `${body}\nexport default function App() { return <p>{label}</p>; }`;
  const MENTIONS: [string, (spec: string) => string][] = [
    ['a line comment', spec => app(`// import X from '${spec}'\nconst label = 'x';`)],
    ['a block comment', spec => app(`/* import X from '${spec}' */\nconst label = 'x';`)],
    ['a string literal', spec => app(`const label = "import X from '${spec}'";`)],
    ['a template literal', spec => app(`const label = \`\nimport X from '${spec}'\n\`;`)],
    ['JSX text', spec => `export default function App() { return <p>import X from '${spec}'</p>; }`],
  ];

  it.each(MENTIONS)('publishes an unsupported package mentioned only in %s', async (_label, build) => {
    const { indexHtml } = await buildReactArtifactBundle({ source: build('lodash-es'), title: 'App' });
    expect(validateBundle({ indexHtml, manifest: [{ path: 'index.html', mimeType: 'text/html' }] }).valid).toBe(true);
    expect(indexHtml).not.toContain('"lodash-es":window');
    expect(renderInert(indexHtml)).not.toMatch(/^Error/);
  });

  it.each(MENTIONS)('does not inline a supported package mentioned only in %s', async (_label, build) => {
    const { indexHtml } = await buildReactArtifactBundle({ source: build('recharts'), title: 'App' });
    expect(indexHtml).not.toContain(RECHARTS_PATH);
    expect(indexHtml).not.toContain('"recharts":window');
    expect(renderInert(indexHtml)).not.toMatch(/^Error/);
  });

  it.each([
    ['a multi-line template literal', "const label = `notes:\nimport 'lodash';\nimport X from './X';\n`;"],
    ['a block comment without star prefixes', "/*\nimport 'lodash';\nimport X from './X';\n*/\nconst label = 'x';"],
  ])('publishes and renders line-initial import text in %s', async (_label, body) => {
    const source = app(body);
    const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App' });
    expect(indexHtml).not.toContain('.run(');
    expect(renderInert(indexHtml)).toMatch(/^<p>/);
  });

  it('accepts the same text in a multi-file entry and its sibling', async () => {
    const note = "const note = `\nimport 'lodash';\nimport Gone from './Gone';\n`;";
    const { indexHtml } = await buildReactArtifactBundle({
      source: `${note}\n${ENTRY}`,
      title: 'App',
      files: { Stopwatch: `/*\nimport 'polyfill';\nimport Y from 'lodash-es';\n*/\n${STOPWATCH}` },
    });
    expect(renderInert(indexHtml)).toBe('<main><span>7</span></main>');
  });

  it('still rejects a real bare package side-effect import with the same message', async () => {
    await expect(
      buildReactArtifactBundle({ source: app(`import 'lodash';\nconst label = 'x';`), title: 'App' })
    ).rejects.toThrow(
      'Side-effect imports (import "...") are not supported. Import a default or named binding, or inline the code.'
    );
    // Not line-initial: the text guard never saw this one, the parse does.
    await expect(
      buildReactArtifactBundle({ source: app(`const label = 'x'; import 'lodash';`), title: 'App' })
    ).rejects.toThrow('Side-effect imports');
  });

  it('still rejects a real unsupported package with the same message', async () => {
    const build = buildReactArtifactBundle({
      source: app(`import X from 'lodash-es';\nconst label = 'x';`),
      title: 'App',
    });
    await expect(build).rejects.toThrow(UnsupportedReactDependencyError);
    await expect(build).rejects.toThrow(new UnsupportedReactDependencyError('lodash-es').message);
  });

  it('still inlines a real supported package and skips a type-only one', async () => {
    const real = await buildReactArtifactBundle({
      source: app(`import { LineChart } from 'recharts';\nconst label = typeof LineChart;`),
      title: 'App',
    });
    expect(real.indexHtml).toContain(RECHARTS_PATH);
    const typeOnly = await buildReactArtifactBundle({
      source: app(`import type { LineChart } from 'recharts';\nconst label = 'x';`),
      title: 'App',
    });
    expect(typeOnly.indexHtml).not.toContain(RECHARTS_PATH);
  });

  it('still accepts a real relative side-effect import in a multi-file entry', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: `// import 'lodash';\nimport './Setup';\nexport default function App() { return <b>x</b>; }`,
      title: 'App',
      files: { Setup: `globalThis.__setup = 1;` },
    });
    expect(renderInert(indexHtml)).toBe('<b>x</b>');
  });
});

describe('runtime module references', () => {
  it.each(["export { sum } from 'lodash';", "export const sum = require('lodash').sum;"])(
    'loads the supported package used by a sibling: %s',
    async source => {
      const { indexHtml } = await buildReactArtifactBundle({
        source: "import { sum } from './Helpers'; export default function App() { return <p>{sum([1, 2])}</p>; }",
        title: 'App',
        files: { Helpers: source },
      });
      expect(indexHtml).toContain('lodash');
      expect(indexHtml).toContain('"lodash":window._');
      expect(
        renderInert(indexHtml, { _: { sum: (values: number[]) => values.reduce((total, value) => total + value, 0) } })
      ).toBe('<p>3</p>');
    }
  );

  it.each(["export { sum } from 'lodash-es';", "export const sum = require('lodash-es').sum;"])(
    'rejects an unsupported runtime package in a sibling: %s',
    async source => {
      await expect(
        buildReactArtifactBundle({
          source: "import { sum } from './Helpers'; export default function App() { return <p>{sum([1, 2])}</p>; }",
          title: 'App',
          files: { Helpers: source },
        })
      ).rejects.toThrow(new UnsupportedReactDependencyError('lodash-es').message);
    }
  );

  it.each(["import('./Panel')", "import('lodash')", 'import(target)'])(
    'rejects a dynamic import instead of publishing an unresolved browser load: %s',
    async expression => {
      await expect(
        buildReactArtifactBundle({
          source: `const target = './Panel'; const load = () => ${expression}; export default function App() { return <p>App</p>; }`,
          title: 'App',
          files: { Panel: 'export default function Panel() { return <p>Panel</p>; }' },
        })
      ).rejects.toThrow('Dynamic imports are not supported for publish. Use a static import instead.');
    }
  );
});

describe('import text remains user content', () => {
  it.each([
    `const label = "import X from 'lodash-es'";`,
    "const label = `import X from 'lodash-es'`;",
    `const label = "import type X from 'lodash-es'";`,
  ])('preserves the exact visible string: %s', async body => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: `${body} export default function App() { return <p>{label}</p>; }`,
      title: 'App',
    });
    const expected = body.includes('import type') ? "import type X from 'lodash-es'" : "import X from 'lodash-es'";
    expect(renderInert(indexHtml)).toBe(`<p>${expected}</p>`);
  });

  it('preserves import text in JSX and in a sibling while still rewriting its real package import', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: "import Panel from './Panel'; export default function App() { return <Panel/>; }",
      title: 'App',
      files: {
        Panel: `import { sum } from 'lodash'; export default function Panel() { return <p>import X from 'lodash-es' {sum([1, 2])}</p>; }`,
      },
    });
    expect(
      renderInert(indexHtml, { _: { sum: (values: number[]) => values.reduce((total, value) => total + value, 0) } })
    ).toBe("<p>import X from 'lodash-es' 3</p>");
  });
});

describe('same-line React imports', () => {
  it.each(["import React from 'react';", "import { useState } from 'react';"])(
    'does not comment out the following entry: %s',
    async reactImport => {
      const { indexHtml } = await buildReactArtifactBundle({
        source: `${reactImport} export default function App() { return <p>ok</p>; }`,
        title: 'App',
      });
      expect(renderInert(indexHtml)).toBe('<p>ok</p>');
    }
  );

  it('keeps the following sibling import reachable', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source:
        "import React from 'react'; import Panel from './Panel'; export default function App() { return <Panel/>; }",
      title: 'App',
      files: { Panel: "import { useState } from 'react'; export default function Panel() { return <p>ok</p>; }" },
    });
    expect(renderInert(indexHtml)).toBe('<p>ok</p>');
  });
});

describe('local require bindings', () => {
  it.each([
    "const label = (() => { function require(value) { return value; } return require('hello'); })();",
    "const label = ((require) => require('hello'))(value => value);",
  ])('does not treat a local function as a package load: %s', async body => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: `${body} export default function App() { return <p>{label}</p>; }`,
      title: 'App',
    });
    expect(renderInert(indexHtml)).toBe('<p>hello</p>');
  });
});

describe('type-only re-exports', () => {
  it.each(["export { type Props } from 'lodash-es';", "export type { Props } from 'lodash-es';"])(
    'does not load an erased sibling export: %s',
    async declaration => {
      const { indexHtml } = await buildReactArtifactBundle({
        source: "import Panel from './Panel'; export default function App() { return <Panel/>; }",
        title: 'App',
        files: { Panel: `${declaration} export default function Panel() { return <p>ok</p>; }` },
      });
      expect(renderInert(indexHtml)).toBe('<p>ok</p>');
      expect(indexHtml).not.toContain('lodash-es');
    }
  );

  it('still loads a mixed value and type re-export', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: "import { sum } from './Helpers'; export default function App() { return <p>{sum([1, 2])}</p>; }",
      title: 'App',
      files: { Helpers: "export { type Props, sum } from 'lodash';" },
    });
    expect(
      renderInert(indexHtml, { _: { sum: (values: number[]) => values.reduce((total, value) => total + value, 0) } })
    ).toBe('<p>3</p>');
  });
});
