// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { CLICK_REF, FILL_REF, pageCall, SNAPSHOT_PAGE, type ElementOutcome, type SnapshotResult } from './pageScripts';

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
