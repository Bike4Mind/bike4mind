import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * shareFooter reads brand config (WEBSITE_URL, APP_NAME, SHARE_* ) from env at module load, so
 * each case stubs the env and re-imports the module fresh.
 */
async function loadFooter(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import('./shareFooter');
  return mod.buildShareFooterHtml;
}

// A marker unique to the built-in Bike4Mind SVG wordmark (a clipPath id in b4mLogo.ts).
const BUILTIN_SVG_MARKER = 'clip0_4034_1502';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('buildShareFooterHtml', () => {
  it('returns empty string when no marketing URL is configured', async () => {
    const build = await loadFooter({ NEXT_PUBLIC_WEBSITE_URL: '', NEXT_PUBLIC_APP_NAME: '' });
    expect(build()).toBe('');
  });

  it('renders a text wordmark (not the built-in SVG) for a fork without the builtin opt-in', async () => {
    const build = await loadFooter({
      NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example',
      NEXT_PUBLIC_APP_NAME: 'Acme',
    });
    const html = build();
    expect(html).not.toContain(BUILTIN_SVG_MARKER);
    expect(html).toContain('>Acme<'); // text wordmark
    expect(html).toContain('Try Acme →'); // CTA uses the brand name
  });

  it('renders the built-in SVG wordmark when SHARE_BUILTIN_LOGO=true', async () => {
    const build = await loadFooter({
      NEXT_PUBLIC_WEBSITE_URL: 'https://bike4mind.com',
      NEXT_PUBLIC_APP_NAME: 'Bike4Mind',
      NEXT_PUBLIC_SHARE_BUILTIN_LOGO: 'true',
    });
    expect(build()).toContain(BUILTIN_SVG_MARKER);
  });

  it('falls back to the neutral brand name in prose when APP_NAME is unset', async () => {
    const build = await loadFooter({ NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example', NEXT_PUBLIC_APP_NAME: '' });
    expect(build()).toContain('Try the app →');
  });

  it('applies a configured palette override', async () => {
    const build = await loadFooter({
      NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example',
      NEXT_PUBLIC_APP_NAME: 'Acme',
      NEXT_PUBLIC_SHARE_BRAND_ORANGE: '#123456',
    });
    expect(build()).toContain('#123456');
  });

  it('escapes a brand name with HTML-significant characters', async () => {
    const build = await loadFooter({
      NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example',
      NEXT_PUBLIC_APP_NAME: 'A&B',
    });
    const html = build();
    expect(html).toContain('A&amp;B');
    expect(html).not.toContain('>A&B<');
  });
});
