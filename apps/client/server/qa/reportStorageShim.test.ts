import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { withStorageShim } from './reportStorageShim';

const shimSource = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

/** A window whose localStorage/sessionStorage getters throw, as in a sandboxed opaque origin. */
function sandboxedWindow() {
  const win: Record<string, unknown> = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(win, name, {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
  }
  return win;
}

function runShim(win: Record<string, unknown>) {
  const html = withStorageShim(Buffer.from('<html><head></head></html>')).toString();
  vm.runInNewContext(shimSource(html), { window: win });
}

describe('withStorageShim', () => {
  it('places the script first in <head>, before the page scripts', () => {
    const out = withStorageShim(
      Buffer.from('<!DOCTYPE html><html><head lang="en"><script>app()</script></head></html>')
    );
    const text = out.toString();
    expect(text.startsWith('<!DOCTYPE html><html><head lang="en"><script>(function(){')).toBe(true);
    expect(text.indexOf('app()')).toBeGreaterThan(text.indexOf('localStorage'));
    expect(text.endsWith('<script>app()</script></head></html>')).toBe(true);
  });

  it('prepends the script when there is no <head>', () => {
    expect(withStorageShim(Buffer.from('<p>x</p>')).toString()).toMatch(/^<script>[\s\S]*<\/script><p>x<\/p>$/);
  });

  it('gives a working in-memory Storage where the real one throws', () => {
    const win = sandboxedWindow();
    runShim(win);
    const storage = win.localStorage as Storage;
    storage.setItem('theme', 'dark');
    storage.setItem('n', 1 as unknown as string);
    expect(storage.getItem('theme')).toBe('dark');
    expect(storage.getItem('n')).toBe('1');
    expect(storage.getItem('missing')).toBeNull();
    expect(storage.length).toBe(2);
    expect(storage.key(0)).toBe('theme');
    expect(storage.key(5)).toBeNull();
    storage.removeItem('theme');
    expect(storage.getItem('theme')).toBeNull();
    storage.clear();
    expect(storage.length).toBe(0);
    expect(() => win.sessionStorage).not.toThrow();
  });

  it('leaves a working Storage alone', () => {
    const real = { getItem: () => 'real' };
    const win: Record<string, unknown> = { localStorage: real, sessionStorage: real };
    runShim(win);
    expect(win.localStorage).toBe(real);
  });
});
