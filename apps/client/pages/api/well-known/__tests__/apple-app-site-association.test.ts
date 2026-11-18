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

import handler from '../apple-app-site-association';

const TEAM_ID = 'AB12CD34EF';

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

describe('GET /api/well-known/apple-app-site-association', () => {
  beforeEach(() => refs.getSettingsMap.mockReset());

  it('is public: Apple fetches it without credentials', () => {
    expect(refs.baseApiOptions).toEqual({ auth: false });
  });

  it('lists no app while no team id is configured', async () => {
    refs.getSettingsMap.mockResolvedValue({});

    const { body, headers } = await get();

    expect(body).toEqual({ applinks: { details: [] }, webcredentials: { apps: [] } });
    expect(headers['Cache-Control']).toBe('public, max-age=300');
    expect(refs.getSettingsMap).toHaveBeenCalledWith(expect.anything(), { names: ['iosAppTeamId'] });
  });

  it('associates the app id with the sign-in callback and session links', async () => {
    refs.getSettingsMap.mockResolvedValue({ iosAppTeamId: TEAM_ID });

    const { body } = await get();

    expect(body).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['AB12CD34EF.com.bike4mind.app'],
            components: [{ '/': '/ios/auth-callback' }, { '/': '/sessions/*' }, { '/': '/notebooks/*' }],
          },
        ],
      },
      webcredentials: { apps: ['AB12CD34EF.com.bike4mind.app'] },
    });
  });

  it('lists no app rather than a malformed team id', async () => {
    refs.getSettingsMap.mockResolvedValue({ iosAppTeamId: 'not-a-team' });

    const { body } = await get();

    expect(body).toEqual({ applinks: { details: [] }, webcredentials: { apps: [] } });
  });
});
