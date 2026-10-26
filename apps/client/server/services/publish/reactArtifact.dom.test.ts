// @vitest-environment jsdom
//
// Execution ("smoke") coverage for the published React bundle. Every OTHER test asserts the bundle
// as a static string (validateBundle never runs anything), so a wrong moduleMap key, a UMD-global
// typo, or a hook ReferenceError in the runtime shim would still ship green. These tests EVAL the
// assembled inline script (and the lucide wrapper) with minimal React/ReactDOM/lucide stubs and
// assert real DOM, so a runtime break in the shim fails the suite.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  assembleReactBundleHtml,
  buildReactArtifactBundle,
  transpileReactModuleProgram,
} from './transpileReactArtifact';
import { LUCIDE_WRAPPER_FN } from '@client/app/utils/reactArtifactDeps';

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

// A tiny React stand-in: createElement builds real DOM (calling function components), hooks are inert.
// Enough to execute the transpiled output and prove it renders without a ReferenceError.
function installReactStub() {
  const React: any = {
    createElement(type: any, props: any, ...children: any[]) {
      props = props || {};
      if (typeof type === 'function') {
        return type({ ...props, children: children.length <= 1 ? children[0] : children });
      }
      const el = document.createElement(String(type));
      for (const [k, v] of Object.entries(props)) {
        if (v == null || k === 'key' || k.startsWith('on')) continue;
        el.setAttribute(k === 'className' ? 'class' : k, String(v));
      }
      const append = (c: any) => {
        if (c == null || c === false || c === true) return;
        if (Array.isArray(c)) return c.forEach(append);
        if (c instanceof Node) el.appendChild(c);
        else el.appendChild(document.createTextNode(String(c)));
      };
      children.forEach(append);
      return el;
    },
    useState: (init: any) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (v: any) => ({ current: v }),
    useMemo: (f: any) => f(),
    useCallback: (f: any) => f,
    useReducer: (_r: any, s: any) => [s, () => {}],
    useContext: () => ({}),
    createContext: (v: any) => ({ _cur: v }),
  };
  (window as any).React = React;
  (window as any).ReactDOM = {
    createRoot: (container: Element) => ({
      render: (el: any) => {
        if (el instanceof Node) container.appendChild(el);
      },
    }),
  };
}

/** Pull the one inline (no-src) bootstrap <script> out of the assembled bundle. */
function extractBootstrap(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const boot = scripts.find(s => s.includes('createRoot') || s.includes('__DEFAULT_EXPORT__'));
  if (!boot) throw new Error('no inline bootstrap script found in bundle');
  return boot;
}

describe('published bundle executes in a DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    delete (window as any).LucideReactWrapper;
  });

  it('mounts a dep-free counter into #root (no ReferenceError, hooks resolve, createElement runs)', async () => {
    installReactStub();
    const { indexHtml } = await buildReactArtifactBundle({ source: COUNTER, title: 'Counter' });

    new Function(extractBootstrap(indexHtml))();

    const root = document.getElementById('root')!;
    // The bootstrap's try/catch renders failures as "Error: ..." into #root - so this also
    // asserts the run did NOT throw.
    expect(root.textContent).not.toContain('Error:');
    expect(root.textContent).toContain('0'); // the count renders
    const buttons = root.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe('+');
  });

  it('resolves a blessed dep through the bundle moduleMap/require (window global -> component)', async () => {
    installReactStub();
    // The bundle maps 'lodash' -> window._ in its moduleMap; stub that global so require('lodash')
    // resolves to it. A wrong moduleMap key or a UMD-global typo would make require throw
    // ("Module ... is not available") -> the bootstrap renders "Error:" and this test fails.
    (window as any)._ = { capitalize: (s: string) => s.toUpperCase() };
    const src = `import { capitalize } from 'lodash';
export default function C() {
  return <div>{capitalize('hi')}</div>;
}`;
    const { indexHtml } = await buildReactArtifactBundle({ source: src, title: 'x' });

    new Function(extractBootstrap(indexHtml))();

    const root = document.getElementById('root')!;
    expect(root.textContent).not.toContain('Error:');
    expect(root.textContent).toContain('HI'); // capitalize ran via require('lodash') -> window._
  });
});

describe('a relative path mentioned only in a comment or string', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    installReactStub();
  });

  it('publishes and mounts as a single file, keeping the mention as text', async () => {
    const source = `import { useState } from 'react';

// ============================================================
// Counter.jsx  (kept here since artifacts can't have sibling files -
// relative imports like \`import Counter from "./Counter"\` are blocked
// by the sandbox. This section is written exactly as it would be.
// ============================================================
function Counter() {
  const [count] = useState(5);
  return <span>{count}</span>;
}

const NOTE = 'import Other from "./Other"';

function App() {
  return <main><Counter /><em>{NOTE}</em></main>;
}

export default App;`;
    const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App' });

    new Function(extractBootstrap(indexHtml))();

    const root = document.getElementById('root')!;
    expect(root.textContent).not.toContain('Error:');
    expect(root.querySelector('span')?.textContent).toBe('5');
    expect(root.querySelector('em')?.textContent).toBe('import Other from "./Other"');
  });
});

describe('package and side-effect import text in a comment or string', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    installReactStub();
  });

  it('publishes and mounts without inlining the mentioned package', async () => {
    const source = `import { useState } from 'react';
/*
import 'lodash';
import { LineChart } from 'recharts';
*/
// import x from 'lodash-es'
const NOTES = \`setup:
import 'polyfill';
import Chart from 'recharts';
\`;

export default function App() {
  const [n] = useState(2);
  return <main><span>{n}</span><pre>{NOTES}</pre><em>import y from "lodash-es"</em></main>;
}`;
    const { indexHtml } = await buildReactArtifactBundle({ source, title: 'App' });
    expect(indexHtml).not.toContain('recharts@');
    expect(indexHtml).not.toContain('lodash@');

    new Function(extractBootstrap(indexHtml))();

    const root = document.getElementById('root')!;
    expect(root.textContent).not.toContain('Error:');
    expect(root.querySelector('span')?.textContent).toBe('2');
    // The text-based import rewrite (shared shape with the preview's) still edits import-shaped text
    // inside strings and JSX text, so only that the text renders is pinned here.
    expect(root.querySelector('pre')?.textContent).toContain('setup:');
    expect(root.querySelector('em')?.textContent).toContain('lodash-es');
  });
});

describe('LUCIDE_WRAPPER_FN executes (the icon logic that previously shipped invisible icons)', () => {
  it('builds a real SVG from a lucide node array and passes through props', () => {
    installReactStub(); // provides window.React for the wrapper's React.createElement calls
    (window as any).lucide = {
      icons: {
        Home: [
          ['path', { d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
          ['polyline', { points: '9 22 9 12 15 12 15 22' }],
        ],
      },
    };

    new Function(LUCIDE_WRAPPER_FN + '\nsetupLucideWrapper();')();

    const el = (window as any).LucideReactWrapper.Home({ size: 16, 'aria-label': 'home', onClick: () => {} });
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.getAttribute('width')).toBe('16');
    expect(el.getAttribute('height')).toBe('16');
    expect(el.getAttribute('aria-label')).toBe('home'); // pass-through prop preserved
    expect(el.querySelectorAll('path').length).toBe(1);
    expect(el.querySelector('path')!.getAttribute('d')).toBe('M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
    expect(el.querySelectorAll('polyline').length).toBe(1);
  });

  it('kebab-cases the icon name when looking it up (ChevronDown -> chevron-down)', () => {
    installReactStub();
    (window as any).lucide = { icons: { 'chevron-down': [['path', { d: 'M6 9l6 6 6-6' }]] } };

    new Function(LUCIDE_WRAPPER_FN + '\nsetupLucideWrapper();')();

    const el = (window as any).LucideReactWrapper.ChevronDown({});
    expect(el.querySelector('path')!.getAttribute('d')).toBe('M6 9l6 6 6-6');
  });
});

describe('multi-file published bundle executes in a DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    installReactStub();
  });

  const run = (indexHtml: string): HTMLElement => {
    new Function(extractBootstrap(indexHtml))();
    return document.getElementById('root')!;
  };

  it('renders an entry that imports a sibling default export', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      title: 'App',
      source: `import Stopwatch from './Stopwatch';
export default function App() { return <main><Stopwatch label="lap" /></main>; }`,
      files: {
        Stopwatch: `import { useState } from 'react';
export default function Stopwatch({ label }: { label: string }) {
  const [ms] = useState(0);
  return <span>{label}:{ms}</span>;
}`,
      },
    });
    const root = run(indexHtml);
    expect(root.textContent).not.toContain('Error:');
    expect(root.innerHTML).toBe('<main><span>lap:0</span></main>');
  });

  it('renders an entry whose default export is `export { X as default }`', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      title: 'App',
      source: `import Tag from './Tag';
function App() { return <main><Tag /></main>; }
export { App as default };`,
      files: { Tag: `export default function Tag() { return <i>tag</i>; }` },
    });
    expect(run(indexHtml).innerHTML).toBe('<main><i>tag</i></main>');
  });

  it('runs a relative side-effect import before the entry reads what it set', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      title: 'App',
      source: `import './Setup';
export default function App() { return <p>{(window as any).__fromSetup}</p>; }`,
      files: { Setup: `(window as any).__fromSetup = 'ready';` },
    });
    expect(run(indexHtml).innerHTML).toBe('<p>ready</p>');
  });

  it('resolves sibling-to-sibling imports, named exports and npm deps used only by a sibling', async () => {
    (window as any)._ = { capitalize: (s: string) => s.toUpperCase() };
    const { indexHtml } = await buildReactArtifactBundle({
      title: 'App',
      source: `import Panel from './components/Panel.tsx';
export default function App() { return <Panel />; }`,
      files: {
        Panel: `import { Title, SUFFIX } from '../ui/title';
export default function Panel() { return <section><Title text={'hi' + SUFFIX} /></section>; }`,
        title: `import { capitalize } from 'lodash';
export const SUFFIX = '!';
export function Title({ text }) { return <h1>{capitalize(text)}</h1>; }`,
      },
    });
    expect(indexHtml).toContain('lodash@4.x.js');
    const root = run(indexHtml);
    expect(root.innerHTML).toBe('<section><h1>HI!</h1></section>');
  });

  it('hands a cycle its partial exports, as Node does', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      title: 'App',
      source: `import { a } from './A';
export default function App() { return <p>{a()}</p>; }`,
      files: {
        A: `import { b, seenA } from './B';
export const a = () => 'a' + b() + seenA;`,
        B: `import * as A from './A';
export const seenA = typeof A.a;
export function b() { return 'b'; }`,
      },
    });
    const root = run(indexHtml);
    // B loads while A is still loading, so A's const export is not assigned yet when B reads it.
    expect(root.innerHTML).toBe('<p>abundefined</p>');
  });

  it('shows the runtime missing-file error when an import names no file', async () => {
    const transpiledCode = await transpileReactModuleProgram(
      `import Gone from './Gone';\nexport default function App() { return <Gone />; }`,
      { Other: 'export default function Other() { return null; }' }
    );
    const root = run(assembleReactBundleHtml({ title: 'App', transpiledCode }));
    expect(root.textContent).toBe(
      'Error: Cannot resolve "./Gone": no artifact file is named "gone". Available files: Other.'
    );
  });

  it('shows the runtime ambiguity error when an import matches several files', async () => {
    const transpiledCode = await transpileReactModuleProgram(
      `import Card from './card';\nexport default function App() { return <Card />; }`,
      {
        Card: 'export default function Card() { return null; }',
        'card.jsx': 'export default function Card() { return null; }',
      }
    );
    const root = run(assembleReactBundleHtml({ title: 'App', transpiledCode }));
    expect(root.textContent).toBe(
      'Error: Cannot resolve "./card": files Card, card.jsx all match "card". Give each file a unique name (case and extension are ignored).'
    );
  });

  it('names the failing sibling when it throws while loading', async () => {
    const { indexHtml } = await buildReactArtifactBundle({
      title: 'App',
      source: `import Boom from './Boom';\nexport default function App() { return <Boom />; }`,
      files: { Boom: `throw new Error('kaput');\nexport default function Boom() { return null; }` },
    });
    expect(run(indexHtml).textContent).toBe('Error: Boom: kaput');
  });
});
