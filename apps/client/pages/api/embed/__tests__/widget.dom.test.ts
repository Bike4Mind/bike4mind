// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../widget';

// Capture the exact loader JS the route serves, then execute it in jsdom so we
// assert real DOM behavior (the substring tests in widget.test.ts cover the
// served source; this covers what it actually does once run).
function servedLoaderJs(): string {
  let body = '';
  const res = {
    setHeader: () => {},
    status() {
      return res;
    },
    send(payload: string) {
      body = payload ?? '';
      return res;
    },
    end() {
      return res;
    },
  } as unknown as NextApiResponse;
  handler({ method: 'GET', headers: {} } as unknown as NextApiRequest, res);
  return body;
}

const ORIGIN = 'https://app.example.com';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function stylesText(): string[] {
  return Array.from(document.head.querySelectorAll('style')).map(s => s.textContent || '');
}

describe('embed loader (executed in jsdom) - launcher theming', () => {
  const loader = servedLoaderJs();

  beforeEach(() => {
    // document.currentScript is null under `new Function`, so the loader takes
    // its querySelector fallback - append a matching tag for it to find. Reset
    // the mount guard + DOM each case or the loader's dedupe guard no-ops.
    // @ts-expect-error test-only reset of the loader's dedupe flag
    delete window.__b4mEmbedMounted;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    const script = document.createElement('script');
    script.setAttribute('data-key', 'b4m_live_x');
    script.setAttribute('src', ORIGIN + '/api/embed/widget');
    document.head.appendChild(script);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runLoader(): void {
    new Function(loader)();
  }

  it('themes the launch button and accessible label from fetched branding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ primaryColor: '#aa00ff', displayName: 'Acme Support' }),
      })
    );
    runLoader();
    await flush();

    const launch = document.getElementById('b4m-embed-launch');
    expect(launch).not.toBeNull();
    expect(launch?.getAttribute('aria-label')).toBe('Acme Support');
    expect(launch?.getAttribute('title')).toBe('Acme Support');
    // An override <style> carries the themed background, and the default style
    // (with #1a1a2e) is left intact - theming is additive.
    expect(stylesText().some(t => t.includes('background:#aa00ff'))).toBe(true);
    expect(stylesText().some(t => t.includes('#1a1a2e'))).toBe(true);
  });

  it('leaves the default bubble intact when the branding fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    runLoader();
    await flush();

    const launch = document.getElementById('b4m-embed-launch');
    expect(launch).not.toBeNull();
    expect(launch?.getAttribute('aria-label')).toBeNull();
    expect(stylesText().some(t => t.includes('#aa00ff'))).toBe(false);
    expect(stylesText().some(t => t.includes('#1a1a2e'))).toBe(true);
  });

  it('rejects a non-hex color at the sink but still applies the display name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ primaryColor: 'red;}body{background:url(//evil.example)', displayName: 'Acme' }),
      })
    );
    runLoader();
    await flush();

    expect(stylesText().some(t => t.includes('evil.example') || t.includes('body{background'))).toBe(false);
    expect(document.getElementById('b4m-embed-launch')?.getAttribute('aria-label')).toBe('Acme');
  });
});
