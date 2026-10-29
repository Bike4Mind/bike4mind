import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from 'electron-vite';
import config from '../../../electron.vite.config';

// Isolate developer-specific .env files while exercising the real exported build config.
vi.mock('electron-vite', async importOriginal => {
  const actual = await importOriginal<typeof import('electron-vite')>();
  return { ...actual, loadEnv: vi.fn() };
});

const API_VARIABLE = 'B4M_DEFAULT_API_URL';
const FEED_VARIABLE = 'B4M_UPDATE_FEED_URL';
const PRODUCTION = 'https://app.bike4mind.com';

function bakedDefinitions() {
  return config({ command: 'build', mode: 'production' }).main?.define;
}

describe('desktop build environment', () => {
  beforeEach(() => {
    vi.stubEnv(API_VARIABLE, undefined);
    vi.stubEnv(FEED_VARIABLE, undefined);
    vi.mocked(loadEnv).mockReset();
    vi.mocked(loadEnv).mockReturnValue({});
  });

  afterEach(() => vi.unstubAllEnvs());

  it('bakes Production and disables updates when no brand environment is provided', () => {
    expect(bakedDefinitions()).toMatchObject({
      [`process.env.${API_VARIABLE}`]: JSON.stringify(PRODUCTION),
      [`process.env.${FEED_VARIABLE}`]: JSON.stringify(''),
    });
  });

  it('uses explicit shell overrides ahead of local environment files', () => {
    vi.stubEnv(API_VARIABLE, 'https://fork.example.com');
    vi.stubEnv(FEED_VARIABLE, 'https://updates.example.com');
    vi.mocked(loadEnv).mockReturnValue({ [API_VARIABLE]: 'https://local.example.com' });

    expect(bakedDefinitions()).toMatchObject({
      [`process.env.${API_VARIABLE}`]: JSON.stringify('https://fork.example.com'),
      [`process.env.${FEED_VARIABLE}`]: JSON.stringify('https://updates.example.com'),
    });
    expect(loadEnv).not.toHaveBeenCalled();
  });

  it('uses local environment files when the shell has no backend override', () => {
    vi.mocked(loadEnv).mockReturnValue({ [API_VARIABLE]: 'https://local.example.com' });

    expect(bakedDefinitions()?.[`process.env.${API_VARIABLE}`]).toBe(JSON.stringify('https://local.example.com'));
    expect(loadEnv).toHaveBeenCalledWith('production', expect.stringContaining('apps/desktop'), 'B4M_');
  });

  it('lets an empty CI backend variable fall through to local files and restores the shell value', () => {
    vi.stubEnv(API_VARIABLE, '');
    vi.mocked(loadEnv).mockImplementationOnce(() => {
      // Vite gives the shell precedence, so it must be absent during the file lookup.
      expect(process.env[API_VARIABLE]).toBeUndefined();
      return { [API_VARIABLE]: 'https://local.example.com' };
    });

    expect(bakedDefinitions()?.[`process.env.${API_VARIABLE}`]).toBe(JSON.stringify('https://local.example.com'));
    expect(process.env[API_VARIABLE]).toBe('');
  });

  it('falls back to Production when an empty CI backend has no local override', () => {
    vi.stubEnv(API_VARIABLE, '');

    expect(bakedDefinitions()?.[`process.env.${API_VARIABLE}`]).toBe(JSON.stringify(PRODUCTION));
    expect(process.env[API_VARIABLE]).toBe('');
  });

  it('keeps an explicitly empty feed disabled even when local files provide a feed', () => {
    vi.stubEnv(FEED_VARIABLE, '');
    vi.mocked(loadEnv).mockReturnValue({ [FEED_VARIABLE]: 'https://updates.example.com' });

    expect(bakedDefinitions()?.[`process.env.${FEED_VARIABLE}`]).toBe(JSON.stringify(''));
    expect(process.env[FEED_VARIABLE]).toBe('');
  });
});
