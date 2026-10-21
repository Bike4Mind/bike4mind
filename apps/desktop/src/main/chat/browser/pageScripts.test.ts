// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLICK_REF,
  FILL_REF,
  pageCall,
  SCROLL_PAGE,
  SNAPSHOT_PAGE,
  type ElementOutcome,
  type SnapshotResult,
} from './pageScripts';

// Indirect eval runs a script at global scope, as executeJavaScript does in the page. The page
// setup goes through it too: the main process's tsconfig has no DOM types to write it against.
const inPage = <T>(script: string): T => (0, eval)(script) as T;
const run = <T>(source: string, ...args: unknown[]): T => inPage<T>(pageCall(source, ...args));

describe('page scripts', () => {
  beforeEach(() => {
    inPage(`
      document.title = 'Sign in';
      document.body.innerHTML =
        '<h1>Welcome back</h1><p>Use your email.</p>' +
        '<form><label for="email">Email</label><input id="email" type="email">' +
        '<label>Password <input type="password" value="hunter2"></label>' +
        '<select aria-label="Currency"><option value="php">PHP</option><option value="usd">USD</option></select>' +
        '<button type="submit">Sign in</button></form>' +
        '<a href="/forgot">Forgot password?</a>' +
        '<div hidden><button>Invisible</button></div>' +
        '<div role="dialog"><p>Cookies?</p><button>Accept</button></div>';
      window.__seen = [];
    `);
  });

  it('outlines the page with refs on interactive elements and never shows a password', () => {
    const snap = run<SnapshotResult>(SNAPSHOT_PAGE, 10_000);
    expect(snap.title).toBe('Sign in');
    expect(snap.text).toContain('# Welcome back');
    expect(snap.text).toContain('[1] input[email] "Email"');
    expect(snap.text).toMatch(/\[2\] input\[password\] "Password"$/m);
    expect(snap.text).not.toContain('hunter2');
    expect(snap.text).toContain('[3] select "Currency" selected="PHP" options=["PHP","USD"]');
    expect(snap.text).toContain('[4] button "Sign in"');
    expect(snap.text).toContain('[5] link "Forgot password?" -> /forgot');
    expect(snap.text).not.toContain('Invisible');
    expect(snap.text).toMatch(/<dialog>\n\s+Cookies\?\n\s+\[6\] button "Accept"/);
  });

  it('keeps refs stable across snapshots and numbers new elements after them', () => {
    run(SNAPSHOT_PAGE, 10_000);
    inPage(`document.body.insertAdjacentHTML('afterbegin', '<button>New</button>')`);
    const again = run<SnapshotResult>(SNAPSHOT_PAGE, 10_000);
    expect(again.text).toContain('[7] button "New"');
    expect(again.text).toContain('[4] button "Sign in"');
  });

  it('stops at the size limit and says so', () => {
    const snap = run<SnapshotResult>(SNAPSHOT_PAGE, 40);
    expect(snap.truncated).toBe(true);
    expect(snap.text.length).toBeLessThanOrEqual(40);
  });

  it('clicks by ref and reports a stale ref', () => {
    run(SNAPSHOT_PAGE, 10_000);
    inPage(
      `document.querySelector('a').addEventListener('click', e => { e.preventDefault(); window.__seen.push('click'); })`
    );
    expect(run<ElementOutcome>(CLICK_REF, '5')).toEqual({ ok: true, description: 'Forgot password?' });
    expect(inPage<string[]>('window.__seen')).toEqual(['click']);
    expect(run<ElementOutcome>(CLICK_REF, '99')).toMatchObject({ ok: false, error: expect.stringContaining('ref 99') });
  });

  it('fills through the native setter and fires input and change', () => {
    run(SNAPSHOT_PAGE, 10_000);
    inPage(`
      const input = document.getElementById('email');
      input.addEventListener('input', () => window.__seen.push('input:' + input.value));
      input.addEventListener('change', () => window.__seen.push('change'));
    `);
    expect(run<ElementOutcome>(FILL_REF, '1', 'test@test.com')).toEqual({
      ok: true,
      description: 'filled "test@test.com"',
    });
    expect(inPage<string[]>('window.__seen')).toEqual(['input:test@test.com', 'change']);
    expect(run<ElementOutcome>(FILL_REF, '2', 'secret')).toEqual({ ok: true, description: 'filled a password field' });
  });

  it('picks a select option by its text or value, and refuses one that is missing', () => {
    run(SNAPSHOT_PAGE, 10_000);
    expect(run<ElementOutcome>(FILL_REF, '3', 'USD')).toEqual({ ok: true, description: 'selected "USD"' });
    expect(inPage<string>(`document.querySelector('select').value`)).toBe('usd');
    expect(run<ElementOutcome>(FILL_REF, '3', 'EUR')).toMatchObject({ ok: false });
    expect(run<ElementOutcome>(FILL_REF, '4', 'x')).toMatchObject({
      ok: false,
      error: expect.stringContaining('button'),
    });
  });
});

describe('scrolling', () => {
  beforeEach(() => {
    inPage(`
      window.__seen = [];
      Element.prototype.scrollIntoView = function (options) {
        window.__seen.push(this.tagName.toLowerCase() + ':' + this.textContent.trim() + ':' + options.block);
      };
      document.body.innerHTML =
        '<main id="panel" aria-label="Feed" style="overflow-y: auto">' +
        '<h2>Plans</h2><p>The <b>Total</b> due today</p><button>Load more</button>' +
        '<p hidden>Secret pricing</p><script>var pricing = 1;</script></main>';
      // jsdom does no layout: give the panel the metrics of a 600px view onto 3000px of content.
      const panel = document.getElementById('panel');
      Object.defineProperty(panel, 'scrollHeight', { value: 3000 });
      Object.defineProperty(panel, 'clientHeight', { value: 600 });
      Object.defineProperty(panel, 'clientWidth', { value: 800 });
      Object.defineProperty(panel, 'scrollTop', { value: 0, writable: true });
      panel.scrollTo = function (options) { this.scrollTop = options.top; };
      document.elementFromPoint = () => panel.querySelector('p');
    `);
  });

  it('brings a ref to the middle of the view', () => {
    run(SNAPSHOT_PAGE, 10_000);
    expect(run<ElementOutcome>(SCROLL_PAGE, { ref: '1' })).toEqual({ ok: true, description: 'Load more' });
    expect(inPage<string[]>('window.__seen')).toEqual(['button:Load more:center']);
  });

  it('finds the first visible element holding some text, even split across inline tags', () => {
    expect(run<ElementOutcome>(SCROLL_PAGE, { text: 'plans' })).toEqual({ ok: true, description: 'Plans' });
    expect(run<ElementOutcome>(SCROLL_PAGE, { text: 'total due' })).toEqual({
      ok: true,
      description: 'The Total due today',
    });
  });

  it('reports a ref or text that matches nothing, never touching a null', () => {
    expect(run<ElementOutcome>(SCROLL_PAGE, { ref: '99' })).toEqual({
      ok: false,
      error: 'No element matched ref 99; take a browser_snapshot for current refs.',
    });
    // Hidden and script text do not count as on the page.
    expect(run<ElementOutcome>(SCROLL_PAGE, { text: 'pricing' })).toEqual({
      ok: false,
      error: 'No visible element matched text "pricing"; take a browser_snapshot for current refs.',
    });
    expect(inPage<string[]>('window.__seen')).toEqual([]);
  });

  it('scrolls the panel under the middle of the view when the document does not scroll', () => {
    expect(run<ElementOutcome>(SCROLL_PAGE, { direction: 'down' })).toEqual({
      ok: true,
      description: 'Scrolled down 540px in the scrollable main "Feed" (now 540px of 2400px).',
    });
    expect(run<ElementOutcome>(SCROLL_PAGE, { direction: 'up', pixels: 100 })).toMatchObject({
      description: expect.stringMatching(/^Scrolled up 100px .*\(now 440px of 2400px\)/),
    });
    expect(run<ElementOutcome>(SCROLL_PAGE, { direction: 'bottom' })).toMatchObject({
      description: 'Scrolled to the bottom of the scrollable main "Feed" (now 2400px of 2400px).',
    });
    expect(run<ElementOutcome>(SCROLL_PAGE, { direction: 'down', pages: 2 })).toEqual({
      ok: true,
      description: 'Already at the bottom of the scrollable main "Feed"; nothing moved.',
    });
  });

  it('falls back to the largest scrolling panel when nothing scrolls under the middle', () => {
    inPage(`document.elementFromPoint = () => null;`);
    expect(run<ElementOutcome>(SCROLL_PAGE, { direction: 'down' })).toMatchObject({
      description: expect.stringContaining('the scrollable main "Feed"'),
    });
  });

  it('says so when nothing on the page scrolls', () => {
    inPage(`document.body.innerHTML = '<p>Short</p>'; document.elementFromPoint = () => null;`);
    expect(run<ElementOutcome>(SCROLL_PAGE, { direction: 'down' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Nothing on this page scrolls'),
    });
  });

  it('outlines only what is in view when asked to', () => {
    inPage(`
      window.innerHeight = 600;
      window.innerWidth = 800;
      const at = (selector, top) => {
        document.querySelector(selector).getBoundingClientRect = () =>
          ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 });
      };
      at('h2', -400);
      at('p', 100);
      at('b', 100);
      at('button', 900);
    `);
    const snap = run<SnapshotResult>(SNAPSHOT_PAGE, 10_000, true);
    expect(snap.text).toContain('The');
    expect(snap.text).not.toContain('Plans');
    expect(snap.text).not.toContain('Load more');
  });
});
