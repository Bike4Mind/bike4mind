import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_SERVER_DOMAIN = process.env.SERVER_DOMAIN;

/**
 * PUBLISH_HOST is derived from SERVER_DOMAIN at module load, so each case loads a
 * fresh copy of the validator with the env it needs (reset between cases).
 */
async function loadValidator(serverDomain?: string) {
  vi.resetModules();
  if (serverDomain === undefined) delete process.env.SERVER_DOMAIN;
  else process.env.SERVER_DOMAIN = serverDomain;
  return (await import('./embedOrigins')).validateEmbedOrigins;
}

async function loadKeyValidator(serverDomain?: string) {
  vi.resetModules();
  if (serverDomain === undefined) delete process.env.SERVER_DOMAIN;
  else process.env.SERVER_DOMAIN = serverDomain;
  return (await import('./embedOrigins')).validateEmbedKeyOrigins;
}

afterEach(() => {
  if (ORIGINAL_SERVER_DOMAIN === undefined) delete process.env.SERVER_DOMAIN;
  else process.env.SERVER_DOMAIN = ORIGINAL_SERVER_DOMAIN;
});

describe('validateEmbedOrigins', () => {
  it('returns an empty list when unset (undefined)', async () => {
    const validate = await loadValidator('bike4mind.com');
    expect(validate(undefined, { isOpenPublic: true })).toEqual({ ok: true, value: [] });
  });

  it('normalizes, dedupes, and accepts a valid list for an open public artifact', async () => {
    const validate = await loadValidator('bike4mind.com');
    const out = validate(['https://Example.com/', 'https://example.com', 'https://b.io'], { isOpenPublic: true });
    expect(out).toEqual({ ok: true, value: ['https://example.com', 'https://b.io'] });
  });

  it('rejects a malformed origin', async () => {
    const validate = await loadValidator('bike4mind.com');
    const out = validate(['http://example.com'], { isOpenPublic: true });
    expect(out).toEqual(expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_INVALID' }));
  });

  it('rejects our own app host and usercontent subdomains', async () => {
    const validate = await loadValidator('bike4mind.com');
    expect(validate(['https://app.bike4mind.com'], { isOpenPublic: true })).toEqual(
      expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_SELF' })
    );
    expect(validate(['https://pub1.usercontent.app.bike4mind.com'], { isOpenPublic: true })).toEqual(
      expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_SELF' })
    );
  });

  it('rejects more than the max number of origins', async () => {
    const validate = await loadValidator('bike4mind.com');
    const many = Array.from({ length: 6 }, (_, i) => `https://s${i}.example.com`);
    expect(validate(many, { isOpenPublic: true })).toEqual(
      expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_LIMIT' })
    );
  });

  it('rejects a non-empty allowlist on a gated (non-open-public) artifact', async () => {
    const validate = await loadValidator('bike4mind.com');
    const out = validate(['https://example.com'], { isOpenPublic: false });
    expect(out).toEqual(expect.objectContaining({ ok: false, code: 'EMBED_REQUIRES_OPEN_PUBLIC' }));
  });

  it('allows an empty list even on a gated artifact (clearing is always valid)', async () => {
    const validate = await loadValidator('bike4mind.com');
    expect(validate([], { isOpenPublic: false })).toEqual({ ok: true, value: [] });
  });

  it('skips the self-host check when SERVER_DOMAIN is unset (fails open only on that rule)', async () => {
    const validate = await loadValidator(undefined);
    // With no PUBLISH_HOST there is nothing to exclude, so a valid external origin passes.
    expect(validate(['https://example.com'], { isOpenPublic: true })).toEqual({
      ok: true,
      value: ['https://example.com'],
    });
  });
});

describe('validateEmbedKeyOrigins', () => {
  it('normalizes, dedupes, and accepts a valid list (no open-public gate)', async () => {
    const validate = await loadKeyValidator('bike4mind.com');
    expect(validate(['https://Example.com/', 'https://example.com', 'https://b.io'])).toEqual({
      ok: true,
      value: ['https://example.com', 'https://b.io'],
    });
  });

  it('applies the same host rules as artifact validation (malformed, self-host, limit)', async () => {
    const validate = await loadKeyValidator('bike4mind.com');
    expect(validate(['http://example.com'])).toEqual(
      expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_INVALID' })
    );
    expect(validate(['https://app.bike4mind.com'])).toEqual(
      expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_SELF' })
    );
    const many = Array.from({ length: 6 }, (_, i) => `https://s${i}.example.com`);
    expect(validate(many)).toEqual(expect.objectContaining({ ok: false, code: 'EMBED_ORIGIN_LIMIT' }));
  });

  it('returns an empty list for undefined or empty input (no open-public requirement)', async () => {
    const validate = await loadKeyValidator('bike4mind.com');
    expect(validate(undefined)).toEqual({ ok: true, value: [] });
    expect(validate([])).toEqual({ ok: true, value: [] });
  });
});

describe('validateEmbedBranding', () => {
  async function loadBrandingValidator() {
    vi.resetModules();
    process.env.SERVER_DOMAIN = 'bike4mind.com';
    return (await import('./embedOrigins')).validateEmbedBranding;
  }

  it('passes undefined through and accepts a valid branding object', async () => {
    const validate = await loadBrandingValidator();
    expect(validate(undefined)).toEqual({ ok: true, value: undefined });
    const branding = { displayName: 'Acme', primaryColor: '#336699', logoUrl: 'https://cdn.example.com/l.png' };
    expect(validate(branding)).toEqual({ ok: true, value: branding });
  });

  it('rejects hostile values with the field named in the error', async () => {
    const validate = await loadBrandingValidator();
    const bad = validate({ logoUrl: 'javascript:alert(1)' });
    expect(bad).toEqual(
      expect.objectContaining({ ok: false, code: 'EMBED_BRANDING_INVALID', error: expect.stringContaining('logoUrl') })
    );
    expect(validate({ primaryColor: 'red;}x{' })).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects a non-object body (param smuggling becomes a 4xx, not a 500)', async () => {
    const validate = await loadBrandingValidator();
    expect(validate('hideBranding=true')).toEqual(expect.objectContaining({ ok: false }));
    expect(validate(42)).toEqual(expect.objectContaining({ ok: false }));
  });
});
