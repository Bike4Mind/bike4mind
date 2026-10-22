import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSelection, resolveEnvironment, validateSelection } from './environment';

const BAKED = 'B4M_DEFAULT_API_URL';

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

  it('drops a stale custom URL when the preset is not custom', () => {
    expect(normalizeSelection({ preset: 'local', customUrl: 'https://b4m.example.com' })).toEqual({ preset: 'local' });
  });
});
