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

  it('states the starter-credit amount it is given', async () => {
    const buildGate = await loadSignupGate();
    const { html } = buildGate({ starterCredits: 12000 });
    expect(html).toContain('<span class="b4m-credits-num">12,000</span>');
    expect(html).toContain('free credits');
  });

  it('states no amount when none is given or none is granted', async () => {
    const buildGate = await loadSignupGate();
    for (const starterCredits of [undefined, null, 0, -5, Number.NaN]) {
      const { html } = buildGate({ starterCredits });
      expect(html).not.toContain('b4m-credits-num');
      expect(html).not.toContain('free credits');
    }
  });
});

describe('replaceSignupGateHtml', () => {
  it('swaps a baked gate for one carrying the live starter-credit amount', async () => {
    const { buildSignupGateHtml, replaceSignupGateHtml } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    const page = `<html><head><style>${gate.styles}</style></head><body><p>content</p>${gate.html}</body></html>`;
    const replaced = replaceSignupGateHtml(page, { starterCredits: 2500 });
    expect(replaced).toContain('<span class="b4m-credits-num">2,500</span>');
    expect(replaced.match(/id="b4m-gate-panel"/g)).toHaveLength(1);
    expect(replaced).toContain('<p>content</p>');
    expect(replaced.endsWith('</body></html>')).toBe(true);
  });

  it('is a no-op on a page without a gate', async () => {
    const { replaceSignupGateHtml } = await import('./shareFooter');
    const page = '<html><body><p>content</p></body></html>';
    expect(replaceSignupGateHtml(page, { starterCredits: 2500 })).toBe(page);
  });
});

describe('buildSignupHref', () => {
  it('points at the app register page with a redirectTo back to the artifact', async () => {
    const { buildSignupHref } = await import('./shareFooter');
    const href = new URL(buildSignupHref({ returnTo: '/p/r/abc', appOrigin: 'https://app.example.com' }));
    expect(href.origin + href.pathname).toBe('https://app.example.com/register');
    expect(href.searchParams.get('redirectTo')).toBe('/p/r/abc');
  });

  it('drops a returnTo that is not a same-origin relative path', async () => {
    const { buildSignupHref } = await import('./shareFooter');
    for (const returnTo of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const href = buildSignupHref({ returnTo });
      expect(href.startsWith('/register?')).toBe(true);
      expect(href).not.toContain('redirectTo');
    }
  });

  it('opens from the gate in a new tab so a sandboxed frame cannot trap it', async () => {
    const { buildSignupGateHtml } = await import('./shareFooter');
    const { html } = buildSignupGateHtml({ returnTo: '/p/r/abc' });
    expect(html).toContain('href="/register?redirectTo=%2Fp%2Fr%2Fabc&amp;');
    expect(html).toContain('target="_blank" rel="noopener"');
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

describe('baked gate detection', () => {
  // A full-HTML artifact never has a gate baked in, but its own body may contain the gate markup.
  const authorPage = (gateHtml: string) =>
    `<html><body><h1>About the gate</h1>${gateHtml}<p>more author content</p></body></html>`;

  it('leaves author content that contains the gate markup untouched', async () => {
    const { buildSignupGateHtml, hasSignupGateHtml, replaceSignupGateHtml, stripSignupGateHtml } =
      await import('./shareFooter');
    const page = authorPage(buildSignupGateHtml().html);
    expect(hasSignupGateHtml(page)).toBe(false);
    expect(stripSignupGateHtml(page)).toBe(page);
    expect(replaceSignupGateHtml(page, { starterCredits: 2500 })).toBe(page);
  });

  it('leaves a bare marker in author content untouched', async () => {
    const { stripSignupGateHtml } = await import('./shareFooter');
    const page = authorPage('<input type="checkbox" id="b4m-gate-dismiss">');
    expect(stripSignupGateHtml(page)).toBe(page);
  });

  it('ignores a gate that is not the last element before the closing body tag', async () => {
    const { buildSignupGateHtml, stripSignupGateHtml } = await import('./shareFooter');
    const { html } = buildSignupGateHtml();
    const page = `<html><body><p>content</p>${html}<div>trailing</div></body></html>`;
    expect(stripSignupGateHtml(page)).toBe(page);
  });

  it('still finds the real gate when author content earlier in the page quotes it', async () => {
    const { buildSignupGateHtml, stripSignupGateHtml } = await import('./shareFooter');
    const { html } = buildSignupGateHtml();
    const page = `<html><body><div>${html}</div><p>after</p>${html}</body></html>`;
    expect(stripSignupGateHtml(page)).toBe(`<html><body><div>${html}</div><p>after</p></body></html>`);
  });

  it('finds a gate baked on a freshly rendered artifact page', async () => {
    const { renderArtifactIndexHtml } = await import('@server/services/publish/renderArtifactHtml');
    const { hasSignupGateHtml, stripSignupGateHtml } = await import('./shareFooter');
    const page = renderArtifactIndexHtml('code', 'const x = 1;', 'T');
    expect(hasSignupGateHtml(page)).toBe(true);
    expect(stripSignupGateHtml(page)).not.toContain('id="b4m-gate-panel"');
  });

  it('strips the original overlay-style gate that older published pages carry', async () => {
    const { hasSignupGateHtml, stripSignupGateHtml } = await import('./shareFooter');
    const legacyGate = [
      '<input type="checkbox" id="b4m-gate-dismiss" style="display:none">',
      '<div id="b4m-gate-ol" aria-hidden="true"></div>',
      '<div id="b4m-gate-panel" role="dialog" aria-label="Sign up to continue reading">',
      '<div class="b4m-gate-handle" aria-hidden="true"></div>',
      '<div class="b4m-gate-inner"><a href="/register" class="b4m-cta-btn">Sign up</a>',
      '<label for="b4m-gate-dismiss" class="b4m-dismiss-label">No, I like my walled garden</label>',
      '</div></div>',
    ].join('');
    const page = `<html><body><p>content</p>${legacyGate}</body></html>`;
    expect(hasSignupGateHtml(page)).toBe(true);
    expect(stripSignupGateHtml(page)).toBe('<html><body><p>content</p></body></html>');
  });

  // A full-HTML artifact that quotes the whole gate as the very last thing in its body is only
  // protected by the share footer the renderer injects after it, so this pins both outcomes.
  describe('a full-HTML artifact whose body ends with a quoted gate', () => {
    async function renderAndStrip(env: Record<string, string>) {
      vi.resetModules();
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const { renderArtifactIndexHtml } = await import('@server/services/publish/renderArtifactHtml');
      const { buildSignupGateHtml, stripSignupGateHtml } = await import('./shareFooter');
      const page = renderArtifactIndexHtml(
        'html',
        `<html><body><p>docs</p>${buildSignupGateHtml().html}</body></html>`,
        'T'
      );
      return { page, stripped: stripSignupGateHtml(page) };
    }

    it('keeps the quoted gate while the renderer injects the share footer after it', async () => {
      const { page, stripped } = await renderAndStrip({ NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example' });
      expect(stripped).toBe(page);
    });

    it('loses the quoted gate when no marketing URL is configured (accepted limitation)', async () => {
      const { page, stripped } = await renderAndStrip({ NEXT_PUBLIC_WEBSITE_URL: '' });
      expect(stripped).not.toBe(page);
      expect(stripped).toContain('<p>docs</p>');
    });
  });
});

// The brand card exactly as pages published before holdShareFooterCtaBeforeGate existed carry
// it (text wordmark, default palette). Pinned so a markup change cannot silently strand them.
const LEGACY_FOOTER_CARD = `<div style="margin-top:3rem;display:flex;justify-content:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">
  <a href="https://acme.example/?utm_source=shared-artifact&utm_medium=share-footer&utm_campaign=publish&utm_content=artifact" target="_blank" rel="noopener noreferrer"
     style="display:flex;align-items:center;gap:16px;max-width:600px;width:100%;padding:14px 18px;
            border:1px solid rgba(255,255,255,.14);border-radius:14px;text-decoration:none;
            background:#0d1830;box-shadow:0 6px 24px rgba(0,0,0,.25)">
    <span style="flex:1;min-width:0">
      <span style="display:block;font-size:20px;font-weight:800;color:#fff;letter-spacing:-.01em">Acme</span>
      <span style="display:block;margin-top:7px;font-size:12.5px;color:#9fb3c8;line-height:1.4">
        <span style="color:#84CC16;font-weight:700">\u2713</span> Create &amp; share AI artifacts like this \u2014 in seconds.
      </span>
${' '.repeat(6)}
    </span>
    <span style="flex:0 0 auto;padding:9px 15px;border-radius:10px;font-weight:700;font-size:13px;white-space:nowrap;
                 background:#F26C1F;color:#fff">Try Acme \u2192</span>
  </a>
</div>`;

describe('holdShareFooterCtaBeforeGate', () => {
  const ACME = { NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example', NEXT_PUBLIC_APP_NAME: 'Acme' };
  const countCtas = (html: string) =>
    (html.match(/utm_medium=share-footer/g) ?? []).length + (html.match(/id="b4m-gate-panel"/g) ?? []).length;
  const held = (card: string) => `<div id="b4m-footer-held" style="display:none">${card}</div>`;

  it('still emits the pinned legacy card bytes', async () => {
    const build = await loadFooter(ACME);
    expect(build({ source: 'artifact' })).toBe(LEGACY_FOOTER_CARD);
  });

  it('leaves exactly one visible sign-up CTA (the gate) on a freshly rendered artifact page', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries(ACME)) vi.stubEnv(k, v);
    const { renderArtifactIndexHtml } = await import('@server/services/publish/renderArtifactHtml');
    const { holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const page = renderArtifactIndexHtml('html', '<p>body</p>', 'T');
    expect(countCtas(page)).toBe(2);

    const stripped = holdShareFooterCtaBeforeGate(page);
    const heldAt = stripped.indexOf('<div id="b4m-footer-held" style="display:none">');
    expect(heldAt).toBeGreaterThan(-1);
    expect(countCtas(stripped.slice(0, heldAt))).toBe(0);
    expect(stripped.indexOf('utm_medium=share-footer')).toBeGreaterThan(heldAt);
    expect(stripped).toContain('id="b4m-gate-panel"');
    expect(stripped).toContain('<p>body</p>');
    expect(stripped.endsWith('</body></html>')).toBe(true);
  });

  it('holds a legacy baked card that sits right before the gate', async () => {
    const { buildSignupGateHtml, holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    const page = `<html><body><p>content</p>${LEGACY_FOOTER_CARD}${gate.html}</body></html>`;
    expect(holdShareFooterCtaBeforeGate(page)).toBe(
      `<html><body><p>content</p>${held(LEGACY_FOOTER_CARD)}${gate.html}</body></html>`
    );
  });

  it('is a no-op without a gate, so a full-document artifact keeps its only CTA', async () => {
    const { holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const page = `<html><body><p>content</p>${LEGACY_FOOTER_CARD}</body></html>`;
    expect(holdShareFooterCtaBeforeGate(page)).toBe(page);
  });

  it('holds the card when a pipeline left CRLF or whitespace around its close', async () => {
    const { buildSignupGateHtml, holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    const crlf = LEGACY_FOOTER_CARD.replace(/\n/g, '\r\n');
    const page = `<html><body><p>content</p>${crlf}\r\n  ${gate.html}</body></html>`;
    expect(holdShareFooterCtaBeforeGate(page)).toBe(
      `<html><body><p>content</p>${held(crlf)}${gate.html}</body></html>`
    );
  });

  it('holds only the card in front of the last (baked) gate when content quotes the marker', async () => {
    const { buildSignupGateHtml, holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    const quoted = `<p>${gate.html}</p>`;
    const page = `<html><body>${quoted}${LEGACY_FOOTER_CARD}${gate.html}</body></html>`;
    expect(holdShareFooterCtaBeforeGate(page)).toBe(
      `<html><body>${quoted}${held(LEGACY_FOOTER_CARD)}${gate.html}</body></html>`
    );
  });

  it('stays linear on a very large page with a far-away card lookalike', async () => {
    const { buildSignupGateHtml, holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    const open = LEGACY_FOOTER_CARD.slice(0, LEGACY_FOOTER_CARD.indexOf('\n'));
    const page = `<html><body>${open}${'<div>x</div>'.repeat(500_000)}${gate.html}</body></html>`;
    const started = performance.now();
    expect(holdShareFooterCtaBeforeGate(page)).toBe(page);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('detects the baked footer card, but not a bare lookalike opening tag', async () => {
    const { hasShareFooterCardHtml } = await import('./shareFooter');
    const open = LEGACY_FOOTER_CARD.slice(0, LEGACY_FOOTER_CARD.indexOf('\n'));
    expect(hasShareFooterCardHtml(`<html><body><p>x</p>${LEGACY_FOOTER_CARD}</body></html>`)).toBe(true);
    expect(hasShareFooterCardHtml(`<html><body>${open}<a href="/elsewhere">x</a></div></body></html>`)).toBe(false);
    expect(hasShareFooterCardHtml('<html><body><p>utm_medium=share-footer</p></body></html>')).toBe(false);
  });

  it('never hides artifact content that merely starts like the card', async () => {
    const { buildSignupGateHtml, holdShareFooterCtaBeforeGate } = await import('./shareFooter');
    const gate = buildSignupGateHtml();
    // An author-written lookalike followed by more author content: the span is not the exact card.
    const page = `<html><body>${LEGACY_FOOTER_CARD}<div><p>author</p></div>${gate.html}</body></html>`;
    expect(holdShareFooterCtaBeforeGate(page)).toBe(page);
  });
});

describe('pickSharedByName', () => {
  it('returns the display name', async () => {
    const { pickSharedByName } = await import('./shareFooter');
    expect(pickSharedByName({ name: ' Ada Lovelace ', username: 'ada_l_1987' })).toBe('Ada Lovelace');
  });

  it('never exposes the raw username or an email', async () => {
    const { pickSharedByName } = await import('./shareFooter');
    expect(pickSharedByName({ name: 'ada_l_1987', username: 'Ada_L_1987' })).toBeUndefined();
    expect(pickSharedByName({ name: 'ada@example.com', username: 'ada' })).toBeUndefined();
    expect(pickSharedByName({ name: '', username: 'ada' })).toBeUndefined();
    expect(pickSharedByName(null)).toBeUndefined();
  });
});

describe('buildShareFooterHtml hideCta', () => {
  it('renders only the report link, with no brand CTA card', async () => {
    const build = await loadFooter({ NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example', NEXT_PUBLIC_APP_NAME: 'Acme' });
    const html = build({ hideCta: true, reportPublicId: 'abc' });
    expect(html).toContain('/report/abc');
    expect(html).not.toContain('utm_medium=share-footer');
    expect(html).not.toContain('Try Acme');
  });
});
