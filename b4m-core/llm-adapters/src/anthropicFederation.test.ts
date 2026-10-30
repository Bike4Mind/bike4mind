import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stsSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(function () {
    return { send: stsSend };
  }),
  GetWebIdentityTokenCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
}));

import { ANTHROPIC_FEDERATED_KEY, AnthropicBackend } from './anthropicBackend';
import { federatedAnthropicCredentials, reuseUntilNearExpiry } from './anthropicFederation';

type Client = { apiKey: string | null; authToken: string | null; credentials: unknown };
const clientOf = (backend: AnthropicBackend) => (backend as unknown as { _api: Client })._api;

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('reuseUntilNearExpiry', () => {
  it('serves the cached token until it nears expiry', async () => {
    const inner = vi.fn(async () => ({ token: 't1', expiresAt: nowSeconds() + 3600 }));
    const provider = reuseUntilNearExpiry(inner);
    await provider();
    await expect(provider()).resolves.toMatchObject({ token: 't1' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('exchanges again inside the refresh margin and on a forced refresh', async () => {
    const inner = vi
      .fn()
      .mockResolvedValueOnce({ token: 'near', expiresAt: nowSeconds() + 60 })
      .mockResolvedValueOnce({ token: 'next', expiresAt: nowSeconds() + 3600 })
      .mockResolvedValueOnce({ token: 'forced', expiresAt: nowSeconds() + 3600 });
    const provider = reuseUntilNearExpiry(inner);
    expect((await provider()).token).toBe('near');
    expect((await provider()).token).toBe('next');
    expect((await provider({ forceRefresh: true })).token).toBe('forced');
  });

  it('coalesces concurrent callers into one exchange', async () => {
    const inner = vi.fn(async () => ({ token: 't', expiresAt: nowSeconds() + 3600 }));
    const provider = reuseUntilNearExpiry(inner);
    await Promise.all([provider(), provider(), provider()]);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed exchange', async () => {
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ token: 'ok', expiresAt: nowSeconds() + 3600 });
    const provider = reuseUntilNearExpiry(inner);
    await expect(provider()).rejects.toThrow('boom');
    expect((await provider()).token).toBe('ok');
  });
});

describe('federated Anthropic client under aws-sts', () => {
  beforeEach(() => {
    vi.stubEnv('PROVIDER_WIF_TOKEN_SOURCE', 'aws-sts');
    vi.stubEnv('ANTHROPIC_FEDERATION_RULE_ID', 'fdrl_test');
    vi.stubEnv('ANTHROPIC_ORGANIZATION_ID', 'org-test');
    vi.stubEnv('ANTHROPIC_SERVICE_ACCOUNT_ID', 'svac_test');
    vi.stubEnv('ANTHROPIC_WORKSPACE_ID', '');
    vi.stubEnv('ANTHROPIC_WIF_AUDIENCE', 'https://aud.example');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-be-used');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    stsSend.mockReset();
  });

  it('builds the client from the shared credentials provider, ignoring ANTHROPIC_API_KEY', () => {
    const api = clientOf(new AnthropicBackend(ANTHROPIC_FEDERATED_KEY));
    expect(api.apiKey).toBeNull();
    expect(api.authToken).toBeNull();
    expect(api.credentials).toBe(federatedAnthropicCredentials());
  });

  it('shares one provider across backends and keys it by config', () => {
    const first = clientOf(new AnthropicBackend(ANTHROPIC_FEDERATED_KEY)).credentials;
    expect(clientOf(new AnthropicBackend(ANTHROPIC_FEDERATED_KEY)).credentials).toBe(first);

    vi.stubEnv('ANTHROPIC_WORKSPACE_ID', 'wrkspc_other');
    expect(clientOf(new AnthropicBackend(ANTHROPIC_FEDERATED_KEY)).credentials).not.toBe(first);
  });

  it('exchanges the STS token at the Anthropic token endpoint', async () => {
    vi.stubEnv('ANTHROPIC_FEDERATION_RULE_ID', 'fdrl_exchange');
    stsSend.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'sk-ant-oat-test', expires_in: 3600, token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await federatedAnthropicCredentials()();

    expect(token.token).toBe('sk-ant-oat-test');
    expect(stsSend).toHaveBeenCalledWith({ input: { Audience: ['https://aud.example'], SigningAlgorithm: 'RS256' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/oauth/token');
    expect(String(init.body)).toContain('sts-jwt');
    expect(String(init.body)).toContain('fdrl_exchange');
  });

  it('names the missing variables', () => {
    vi.stubEnv('ANTHROPIC_WIF_AUDIENCE', '');
    expect(() => new AnthropicBackend(ANTHROPIC_FEDERATED_KEY)).toThrow(/ANTHROPIC_WIF_AUDIENCE/);
  });

  it('leaves a static key untouched', () => {
    const api = clientOf(new AnthropicBackend('sk-ant-static'));
    expect(api.apiKey).toBe('sk-ant-static');
    expect(api.credentials).toBeNull();
  });
});
