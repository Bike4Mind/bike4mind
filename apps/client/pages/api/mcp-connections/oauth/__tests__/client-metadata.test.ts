import { afterEach, describe, expect, it, vi } from 'vitest';

const refs = vi.hoisted(() => ({ baseApiOptions: undefined as unknown }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    refs.baseApiOptions = options;
    return { get: (fn: (req: unknown, res: unknown) => unknown) => fn };
  },
}));

import handler from '../client-metadata';

describe('GET /api/mcp-connections/oauth/client-metadata', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is public: the authorization server fetches it without credentials', () => {
    expect(refs.baseApiOptions).toEqual({ auth: false });
  });

  it('serves a public-client metadata document whose client_id is its own URL', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    let body: Record<string, unknown> | undefined;
    const res = { setHeader: vi.fn(), json: (b: Record<string, unknown>) => (body = b) };
    (handler as unknown as (req: unknown, res: unknown) => void)({}, res);
    expect(body).toMatchObject({
      client_id: 'https://app.example.com/.well-known/oauth-client/mcp-client.json',
      redirect_uris: ['https://app.example.com/integrations/mcp-oauth-callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });
});
