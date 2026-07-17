// @vitest-environment jsdom
//
// Execution ("smoke") coverage for the published React bundle. Every OTHER test asserts the bundle
// as a static string (validateBundle never runs anything), so a wrong moduleMap key, a UMD-global
// typo, or a hook ReferenceError in the runtime shim would still ship green. These tests EVAL the
// assembled inline script (and the lucide wrapper) with minimal React/ReactDOM/lucide stubs and
// assert real DOM, so a runtime break in the shim fails the suite.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildReactArtifactBundle } from './transpileReactArtifact';
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
