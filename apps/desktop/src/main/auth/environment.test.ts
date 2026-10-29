import { afterEach, describe, expect, it } from 'vitest';
import { migrateSelection, normalizeSelection, resolveEnvironment, validateSelection } from './environment';

const BAKED = 'B4M_DEFAULT_API_URL';
const HOSTED = 'https://hosted.example.com';

afterEach(() => {
  delete process.env[BAKED];
});

describe('resolveEnvironment', () => {
  it('uses the baked default for the hosted preset', () => {
    process.env[BAKED] = 'https://b4m.example.com';

    const resolved = resolveEnvironment({ preset: 'hosted' }, false);

    expect(resolved).toEqual({
      status: 'configured',
      environment: { preset: 'hosted', url: 'https://b4m.example.com', label: 'Production' },
    });
  });

  it('honors an explicit local pick over the baked default', () => {
    process.env[BAKED] = 'https://b4m.example.com';

    const resolved = resolveEnvironment({ preset: 'local' }, false);

    expect(resolved).toEqual({
      status: 'configured',
      environment: { preset: 'local', url: 'http://localhost:3000', label: 'Local Dev' },
    });
  });

  it('labels a remote custom URL distinctly from a local one', () => {
    const remote = resolveEnvironment({ preset: 'custom', customUrl: 'https://b4m.internal' }, false);
    const localCustom = resolveEnvironment({ preset: 'custom', customUrl: 'http://127.0.0.1:3000' }, false);

    expect(remote).toMatchObject({ environment: { label: 'Remote' } });
    expect(localCustom).toMatchObject({ environment: { label: 'Local Dev' } });
  });

  it('is unconfigured for an unbranded packaged build with no choice made', () => {
    expect(resolveEnvironment(undefined, false)).toEqual({ status: 'unconfigured' });
  });

  it('starts a packaged build with a baked default on Production when nothing is stored', () => {
    process.env[BAKED] = HOSTED;

    expect(resolveEnvironment(undefined, false)).toEqual({
      status: 'configured',
      environment: { preset: 'hosted', url: HOSTED, label: 'Production' },
    });
  });

  it('treats an empty baked default as a fork with no hosted option', () => {
    process.env[BAKED] = '';

    expect(resolveEnvironment(undefined, false)).toEqual({ status: 'unconfigured' });
  });

  it('resolves a custom pick of the production URL as Production', () => {
    process.env[BAKED] = HOSTED;

    expect(resolveEnvironment({ preset: 'custom', customUrl: `${HOSTED.toUpperCase()}/` }, false)).toEqual({
      status: 'configured',
      environment: { preset: 'hosted', url: HOSTED, label: 'Production' },
    });
  });

  it('keeps a custom URL that is not the production one', () => {
    process.env[BAKED] = HOSTED;

    expect(resolveEnvironment({ preset: 'custom', customUrl: 'https://self-hosted.example.com' }, false)).toEqual({
      status: 'configured',
      environment: { preset: 'custom', url: 'https://self-hosted.example.com', label: 'Remote' },
    });
  });

  it('falls back to the dev server for a source run', () => {
    expect(resolveEnvironment(undefined, true)).toMatchObject({
      status: 'configured',
      environment: { preset: 'local', url: 'http://localhost:3000' },
    });
  });

  it('does not silently substitute the hosted service for a custom pick that lost its URL', () => {
    process.env[BAKED] = 'https://b4m.example.com';

    expect(resolveEnvironment({ preset: 'custom' }, true)).toEqual({ status: 'unconfigured' });
  });
});

describe('migrateSelection', () => {
  it.each([
    ['https://hosted.example.com/Api', 'https://hosted.example.com/api'],
    ['https://hosted.example.com?tenant=Acme', 'https://hosted.example.com?tenant=acme'],
    ['https://User:Secret@hosted.example.com', 'https://user:secret@hosted.example.com'],
    ['https://hosted.example.com?tenant=acme/', 'https://hosted.example.com?tenant=acme'],
  ])('preserves a distinct custom endpoint %s', (baked, customUrl) => {
    process.env[BAKED] = baked;
    const selection = { preset: 'custom' as const, customUrl };

    expect(migrateSelection(selection)).toBe(selection);
    expect(normalizeSelection(selection)).toEqual(selection);
    expect(resolveEnvironment(selection, false)).toMatchObject({
      environment: { preset: 'custom', url: customUrl },
    });
  });

  it('turns a custom pick of the production URL into the hosted preset', () => {
    process.env[BAKED] = HOSTED;

    expect(migrateSelection({ preset: 'custom', customUrl: HOSTED })).toEqual({ preset: 'hosted' });
  });

  it('returns every other selection unchanged, by reference', () => {
    process.env[BAKED] = HOSTED;
    const other = { preset: 'custom' as const, customUrl: 'https://self-hosted.example.com' };

    expect(migrateSelection(other)).toBe(other);
    expect(migrateSelection(undefined)).toBeUndefined();
  });

  it('migrates nothing in a fork, where there is no production URL to match', () => {
    const custom = { preset: 'custom' as const, customUrl: HOSTED };

    expect(migrateSelection(custom)).toBe(custom);
  });
});

describe('validateSelection', () => {
  it('rejects a custom URL that is not an http(s) origin', () => {
    expect(validateSelection({ preset: 'custom', customUrl: 'ftp://b4m.example.com' }).ok).toBe(false);
    expect(validateSelection({ preset: 'custom', customUrl: '' }).ok).toBe(false);
    expect(validateSelection({ preset: 'custom', customUrl: 'https://b4m.example.com' }).ok).toBe(true);
  });

  it('does not require a URL for the presets that supply their own', () => {
    expect(validateSelection({ preset: 'hosted' }).ok).toBe(true);
    expect(validateSelection({ preset: 'local' }).ok).toBe(true);
  });
});

describe('normalizeSelection', () => {
  it('trims and strips a trailing slash so the stored URL matches the token cache key', () => {
    expect(normalizeSelection({ preset: 'custom', customUrl: '  https://b4m.example.com/  ' })).toEqual({
      preset: 'custom',
      customUrl: 'https://b4m.example.com',
    });
  });

  it('stores a typed-in production URL as the hosted preset', () => {
    process.env[BAKED] = HOSTED;

    expect(normalizeSelection({ preset: 'custom', customUrl: ` ${HOSTED}/ ` })).toEqual({ preset: 'hosted' });
  });

  it('drops a stale custom URL when the preset is not custom', () => {
    expect(normalizeSelection({ preset: 'local', customUrl: 'https://b4m.example.com' })).toEqual({ preset: 'local' });
  });
});
