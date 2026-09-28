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

async function loadSignupGate(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import('./shareFooter');
  return mod.buildSignupGateHtml;
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

// b4m-bob#318: the prompt must be an honest, dismissible invitation, not a fake gate over
// content that's already been delivered on the page.
describe('buildSignupGateHtml', () => {
  it('does not lock scroll or render a blur/overlay layer', async () => {
    const buildGate = await loadSignupGate();
    const { styles, html } = buildGate();
    expect(styles).not.toContain('overflow:hidden');
    expect(styles).not.toContain('b4m-gate-ol');
    expect(html).not.toContain('b4m-gate-ol');
  });

  it('is not a modal dialog', async () => {
    const buildGate = await loadSignupGate();
    const { html } = buildGate();
    expect(html).not.toContain('role="dialog"');
  });

  it('does not claim to withhold content', async () => {
    const buildGate = await loadSignupGate();
    const { html } = buildGate();
    expect(html).not.toContain('Read the rest');
    expect(html).not.toContain('walled garden');
    expect(html).toContain('Like this?');
  });

  it('keeps a keyboard-accessible dismiss control', async () => {
    const buildGate = await loadSignupGate();
    const { html } = buildGate();
    expect(html).toContain('id="b4m-gate-dismiss"');
    expect(html).toContain('for="b4m-gate-dismiss"');
  });
});

describe('shouldShowSignupGate', () => {
  it('shows only to an anonymous viewer of an open-public artifact', async () => {
    const { shouldShowSignupGate } = await import('./shareFooter');
    expect(shouldShowSignupGate('public', undefined)).toBe(true);
    expect(shouldShowSignupGate('public', null)).toBe(true);
    expect(shouldShowSignupGate('public', {})).toBe(true);
  });

  it('never shows to a signed-in viewer, owner or not', async () => {
    const { shouldShowSignupGate } = await import('./shareFooter');
    expect(shouldShowSignupGate('public', { id: 'owner1' })).toBe(false);
    expect(shouldShowSignupGate('organization', { id: 'colleague' })).toBe(false);
  });

  it('never shows on a non-public artifact', async () => {
    const { shouldShowSignupGate } = await import('./shareFooter');
    for (const v of ['private', 'organization', 'project'] as const) {
      expect(shouldShowSignupGate(v, undefined)).toBe(false);
    }
  });
});

describe('stripSignupGateHtml', () => {
  it('removes the baked gate markup and leaves the rest of the page intact', async () => {
    const { buildSignupGateHtml, stripSignupGateHtml } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    const page = `<html><head><style>${gate.styles}</style></head><body><p>content</p><footer>f</footer>${gate.html}</body></html>`;
    const stripped = stripSignupGateHtml(page);
    expect(stripped).not.toContain('b4m-gate-dismiss"');
    expect(stripped).not.toContain('b4m-gate-panel"');
    expect(stripped).toContain('<p>content</p><footer>f</footer></body></html>');
  });

  it('is a no-op on a page without a gate', async () => {
    const { stripSignupGateHtml } = await import('./shareFooter');
    const page = '<html><body><p>content</p></body></html>';
    expect(stripSignupGateHtml(page)).toBe(page);
  });
});
