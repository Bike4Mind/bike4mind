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
