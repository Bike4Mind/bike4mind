import { beforeEach, describe, expect, it, vi } from 'vitest';

const refs = vi.hoisted(() => ({ baseApiOptions: undefined as unknown, getSettingsMap: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    refs.baseApiOptions = options;
    return { get: (fn: (req: unknown, res: unknown) => unknown) => fn };
  },
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: refs.getSettingsMap,
}));

import handler from '../assetlinks';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

async function get(): Promise<{ body: unknown; headers: Record<string, string> }> {
  let body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => (headers[name] = value),
    json: (b: unknown) => (body = b),
  };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)({}, res);
  return { body, headers };
}

describe('GET /api/well-known/assetlinks', () => {
  beforeEach(() => refs.getSettingsMap.mockReset());

  it('is public: Android fetches it without credentials', () => {
    expect(refs.baseApiOptions).toEqual({ auth: false });
  });

  it('serves an empty statement list while no fingerprint is configured', async () => {
    refs.getSettingsMap.mockResolvedValue({});

    const { body, headers } = await get();

    expect(body).toEqual([]);
    expect(headers['Cache-Control']).toBe('public, max-age=300');
    expect(refs.getSettingsMap).toHaveBeenCalledWith(expect.anything(), { names: ['androidAppCertFingerprints'] });
  });

  it('delegates handle_all_urls to the Android package for the configured fingerprints', async () => {
    refs.getSettingsMap.mockResolvedValue({ androidAppCertFingerprints: JSON.stringify([FINGERPRINT]) });

    const { body } = await get();

    expect(body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.bike4mind.app',
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });

  it('serves nothing rather than a malformed fingerprint', async () => {
    refs.getSettingsMap.mockResolvedValue({ androidAppCertFingerprints: JSON.stringify(['not-a-fingerprint']) });

    const { body } = await get();

    expect(body).toEqual([]);
  });
});
