import vm from 'node:vm';
import * as Babel from '@babel/standalone';
import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../react-artifact-sandbox';
import { OPTIONAL_DEP_CDN } from '@client/app/utils/reactArtifactDeps';

/**
 * Multi-file rendering, driven through the real served scripts in a vm with the real Babel and a
 * tiny React stand-in, in both execution modes. Inert mode runs in a context that forbids string
 * code generation, so any eval / new Function on that path fails the test.
 */
function sandboxHtml(): string {
  let body = '';
  const res = {
    setHeader: () => undefined,
    status: () => res,
    send: (payload: string) => {
      body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  handler({ method: 'GET' } as NextApiRequest, res);
  return body;
}

function inlineScript(html: string, marker: string): string {
  const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), m => m[1]).filter(b => b.includes(marker));
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

const HTML = sandboxHtml();
const FACTORY_BLOCK = inlineScript(HTML, 'var importScanner = null;');
const MAIN_BLOCK = inlineScript(HTML, 'function renderArtifact(');

interface FakeElement {
  type: unknown;
  props: Record<string, unknown>;
}

const FakeReact = {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement => ({
    type,
    props: { ...(props ?? {}), children },
  }),
  useState: <T>(value: T) => [value, () => undefined],
  useEffect: () => undefined,
  useRef: <T>(value: T) => ({ current: value }),
  useMemo: <T>(fn: () => T) => fn(),
  useCallback: <T>(fn: T) => fn,
  useReducer: <T>(_reducer: unknown, state: T) => [state, () => undefined],
  useContext: () => undefined,
  createContext: () => ({}),
};

/** Expands function components and prints the host elements, e.g. `<div><span>x</span></div>`. */
function markup(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(markup).join('');
  if (typeof node !== 'object') return String(node);
  const { type, props } = node as FakeElement;
  if (typeof type === 'function') return markup((type as (p: Record<string, unknown>) => unknown)(props));
  return `<${String(type)}>${markup(props.children)}</${String(type)}>`;
}

type Mode = 'eval' | 'inert';

interface RenderResult {
  markup: string | null;
  errors: string[];
  babelOptions: Record<string, unknown>[];
  inlineScripts: number;
  functionConstructions: number;
}

interface RenderMessage {
  code: string;
  dependencies?: string[];
  files?: unknown;
}

const FAKE_DEP_GLOBALS: Record<string, unknown> = {
  lodash: { sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0) },
};

async function render(mode: Mode, message: RenderMessage): Promise<RenderResult> {
  const posted: { type: string; message?: string }[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const babelOptions: Record<string, unknown>[] = [];
  let rendered: unknown = undefined;
  let inlineScripts = 0;

  const parent = { postMessage: (msg: { type: string; message?: string }) => posted.push(msg) };
  const window: Record<string, unknown> = {
    parent,
    React: FakeReact,
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ||= []).push(fn),
  };
  const element = (): Record<string, unknown> => ({ appendChild: () => undefined });
  const head = {
    appendChild: (script: { src?: string; onload?: () => void }) => {
      const dep = Object.entries(OPTIONAL_DEP_CDN).find(([, meta]) => meta.url === script.src);
      if (dep) window[dep[1].globalVar] = FAKE_DEP_GLOBALS[dep[0]];
      script.onload?.();
    },
  };
  const body = {
    appendChild: (script: { textContent?: string }) => {
      inlineScripts++;
      try {
        vm.runInContext(String(script.textContent), context);
      } catch (error) {
        // A browser reports an uncaught inline-script error as a window error event.
        for (const fn of listeners.error ?? []) fn({ error, message: (error as Error).message });
      }
    },
  };
  const context = vm.createContext(
    {
      window,
      setTimeout: () => 0,
      document: {
        getElementById: element,
        createElement: element,
        createTextNode: (text: string) => ({ text }),
        head,
        body,
      },
      React: FakeReact,
      ReactDOM: { createRoot: () => ({ render: (el: unknown) => (rendered = el) }) },
      Babel: {
        transform: (code: string, opts: Record<string, unknown>) => {
          babelOptions.push(opts);
          return Babel.transform(code, opts as Parameters<typeof Babel.transform>[1]);
        },
      },
    },
    // Inert mode must never compile code from a string; eval mode needs exactly one new Function.
    { codeGeneration: { strings: mode === 'eval', wasm: false } }
  );
  vm.runInContext(
    'var __functionConstructions = 0; Function = (function (F) { function Counted() { __functionConstructions++; return F.apply(this, arguments); } Counted.prototype = F.prototype; return Counted; })(Function);',
    context
  );
  vm.runInContext(FACTORY_BLOCK, context);
  vm.runInContext(MAIN_BLOCK, context);

  for (const fn of listeners.message ?? []) {
    fn({ source: parent, data: { type: 'react-artifact-render', mode, dependencies: [], ...message } });
  }
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));

  return {
    markup: rendered === undefined ? null : markup(rendered),
    errors: posted.filter(m => m.type === 'react-sandbox-error').map(m => String(m.message)),
    babelOptions,
    inlineScripts,
    functionConstructions: (context as unknown as { __functionConstructions: number }).__functionConstructions,
  };
}

const MODES: Mode[] = ['eval', 'inert'];

const RELATIVE_REJECTION =
  'Multi-file artifacts are not supported yet \u2014 this one references "./Chronosphere" from a separate file. ' +
  'Ask for a single, self-contained component (one file, one default export).';

const ENTRY = [
  "import React from 'react';",
  'import Chronosphere from "./Chronosphere";',
  'export default function App() {',
  '  return <div><Chronosphere label="tick" /></div>;',
  '}',
].join('\n');

const CHRONOSPHERE = [
  'type Props = { label: string };',
  'export default function Chronosphere({ label }: Props) {',
  '  const [count] = useState(3);',
  '  return <span>{label}{count}</span>;',
  '}',
].join('\n');

describe.each(MODES)('multi-file react artifacts (%s mode)', mode => {
  it('renders an entry that imports the default export of one sibling', async () => {
    const result = await render(mode, { code: ENTRY, files: { Chronosphere: CHRONOSPHERE } });
    expect(result.errors).toEqual([]);
    expect(result.markup).toBe('<div><span>tick3</span></div>');
    if (mode === 'inert') expect(result.inlineScripts).toBe(1);
    else expect(result.functionConstructions).toBe(1);
  });

  it('links siblings that import siblings, with named, default and re-exports across path forms', async () => {
    const code = [
      "import Panel, { title } from './components/Panel.tsx';",
      "import * as utils from '../utils';",
      'export default function App() { return <main>{title}{utils.double(2)}<Panel /></main>; }',
    ].join('\n');
    const files = {
      'Panel.tsx': [
        "import { Badge, VERSION } from './badge.js';",
        "export const title = 'T';",
        'export default function Panel() { return <section><Badge n={VERSION} /></section>; }',
      ].join('\n'),
      Badge: "export { Badge } from './BadgeImpl';\nexport const VERSION = 2;",
      BadgeImpl: 'export function Badge({ n }: { n: number }) { return <b>{n}</b>; }',
      utils: 'export const double = (n: number): number => n * 2;',
    };
    const result = await render(mode, { code, files });
    expect(result.errors).toEqual([]);
    expect(result.markup).toBe('<main>T4<section><b>2</b></section></main>');
  });

  it('hands a module required mid-load its partial exports, so a cycle terminates', async () => {
    const code = "import { both } from './a';\nexport default function App() { return <p>{both()}</p>; }";
    const files = {
      a: "import { b } from './b';\nexport const a = 'A';\nexport function both() { return a + b(); }",
      b: "import { a } from './a';\nexport const early = typeof a;\nexport function b() { return 'B' + a; }",
    };
    const result = await render(mode, { code, files });
    expect(result.errors).toEqual([]);
    expect(result.markup).toBe('<p>ABA</p>');
  });

  it('gives a sibling the same React the entry renders with, including non-hook named imports', async () => {
    const code = [
      "import { reactOf, Tag } from './Sib';",
      'export default function App() { return <i>{String(reactOf() === React)}<Tag /></i>; }',
    ].join('\n');
    const files = {
      Sib: [
        "import React, { useMemo, createElement } from 'react';",
        'export function reactOf() { return useMemo(() => React); }',
        "export const Tag = () => createElement('u', null, 'x');",
      ].join('\n'),
    };
    const result = await render(mode, { code, files });
    expect(result.errors).toEqual([]);
    expect(result.markup).toBe('<i>true<u>x</u></i>');
  });

  it('resolves an npm dependency that only a sibling imports', async () => {
    const code = "import { Total } from './Total';\nexport default function App() { return <Total />; }";
    const files = {
      Total: "import _ from 'lodash';\nexport function Total() { return <em>{_.sum([1, 2, 3])}</em>; }",
    };
    const result = await render(mode, { code, files, dependencies: ['lodash'] });
    expect(result.errors).toEqual([]);
    expect(result.markup).toBe('<em>6</em>');
  });

  it('names the specifier and the available files when a relative import has no match', async () => {
    const code = "import Missing from './widgets/Missing';\nexport default function App() { return <Missing />; }";
    const result = await render(mode, { code, files: { Chronosphere: CHRONOSPHERE, 'utils.ts': 'export {};' } });
    expect(result.markup).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"./widgets/Missing"');
    expect(result.errors[0]).toContain('Available files: Chronosphere, utils.ts.');
  });

  it('reports two files whose names normalize alike instead of picking one', async () => {
    const code = "import Chart from './Chart';\nexport default function App() { return <Chart />; }";
    const files = {
      'Chart.tsx': 'export default () => <b>1</b>;',
      'components/chart.jsx': 'export default () => <b>2</b>;',
    };
    const result = await render(mode, { code, files });
    expect(result.markup).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"./Chart"');
    expect(result.errors[0]).toContain('Chart.tsx, components/chart.jsx');
  });

  it('names the sibling a transpile or top-level error came from, and ignores broken unused files', async () => {
    const broken = await render(mode, {
      code: "import Broken from './Broken';\nexport default function App() { return <Broken />; }",
      files: { Broken: 'export default function Broken() { return <div>; }' },
    });
    expect(broken.errors).toEqual([expect.stringContaining('Broken.tsx')]);

    const thrower = await render(mode, {
      code: "import { x } from './Thrower';\nexport default function App() { return <b>{x}</b>; }",
      files: { Thrower: "throw new Error('boom');\nexport const x = 1;" },
    });
    expect(thrower.errors).toEqual(['Thrower: boom']);

    const unused = await render(mode, {
      code: ENTRY,
      files: { Chronosphere: CHRONOSPHERE, Unused: 'export default function () { return <div>; }' },
    });
    expect(unused.errors).toEqual([]);
    expect(unused.markup).toBe('<div><span>tick3</span></div>');
  });

  it('keeps rejecting a relative import with the existing message when no files map is supplied', async () => {
    for (const files of [undefined, null, ['Chronosphere']]) {
      const result = await render(mode, { code: ENTRY, files });
      expect(result.markup).toBeNull();
      expect(result.errors).toEqual([RELATIVE_REJECTION]);
      expect(result.babelOptions).toEqual([]);
    }
  });

  it('names the missing file when an empty files map opts in, listing the available files as none', async () => {
    for (const files of [{}, { NotSource: 42 }]) {
      const result = await render(mode, { code: ENTRY, files });
      expect(result.markup).toBeNull();
      expect(result.errors).toEqual([
        'Cannot resolve "./Chronosphere": no artifact file is named "chronosphere". Available files: none.',
      ]);
    }
  });

  it('renders a single-file artifact on the unchanged single-file path, files or not', async () => {
    const code =
      "import React, { useState } from 'react';\nexport default function App() { const [v] = useState('ok'); return <h1>{v}</h1>; }";
    for (const files of [undefined, { Chronosphere: CHRONOSPHERE }]) {
      const result = await render(mode, { code, files });
      expect(result.errors).toEqual([]);
      expect(result.markup).toBe('<h1>ok</h1>');
      expect(result.babelOptions).toEqual([
        { presets: [['react', { runtime: 'classic' }], 'typescript'], filename: 'component.tsx' },
      ]);
    }
  });
});
