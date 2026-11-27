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

import { OPENAI_FEDERATED_KEY, OpenAIBackend } from './openaiBackend';
import { githubActionsIdToken } from './wifTokenSource';

const ENV_NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_IDENTITY_PROVIDER_ID',
  'OPENAI_SERVICE_ACCOUNT_ID',
  'OPENAI_WIF_AUDIENCE',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'PROVIDER_WIF_TOKEN_SOURCE',
];

const clientKey = (backend: OpenAIBackend) => (backend as unknown as { _api: { apiKey: string | null } })._api.apiKey;

type WorkloadIdentityClient = {
  _options: { apiKey: () => Promise<string> };
};
const apiOf = (backend: OpenAIBackend) => (backend as unknown as { _api: WorkloadIdentityClient })._api;

describe('OpenAIBackend federated key', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ENV_NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.unstubAllGlobals();
  });

  it('treats the literal federated string as a static user key', () => {
    expect(clientKey(new OpenAIBackend('federated'))).toBe('federated');
  });

  it('passes a real key through unchanged', () => {
    expect(clientKey(new OpenAIBackend('sk-test'))).toBe('sk-test');
  });

  it('builds a keyless client for the federated sentinel, even with OPENAI_API_KEY in the environment', () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
    process.env.OPENAI_IDENTITY_PROVIDER_ID = 'idp_test';
    process.env.OPENAI_SERVICE_ACCOUNT_ID = 'sa_test';
    process.env.OPENAI_WIF_AUDIENCE = 'aud-test';
    expect(clientKey(new OpenAIBackend(OPENAI_FEDERATED_KEY))).toBeNull();
  });

  it('reuses one federated client per config so its token cache survives across requests', () => {
    process.env.OPENAI_IDENTITY_PROVIDER_ID = 'idp_reuse';
    process.env.OPENAI_SERVICE_ACCOUNT_ID = 'sa_reuse';
    process.env.OPENAI_WIF_AUDIENCE = 'aud-reuse';
    const first = apiOf(new OpenAIBackend(OPENAI_FEDERATED_KEY));
    expect(apiOf(new OpenAIBackend(OPENAI_FEDERATED_KEY))).toBe(first);

    process.env.OPENAI_WIF_AUDIENCE = 'aud-other';
    expect(apiOf(new OpenAIBackend(OPENAI_FEDERATED_KEY))).not.toBe(first);
  });

  it('still builds a fresh client per backend for a static key', () => {
    expect(apiOf(new OpenAIBackend('sk-a'))).not.toBe(apiOf(new OpenAIBackend('sk-a')));
  });

  it('exchanges an STS subject token under PROVIDER_WIF_TOKEN_SOURCE=aws-sts', async () => {
    process.env.PROVIDER_WIF_TOKEN_SOURCE = 'aws-sts';
    process.env.OPENAI_IDENTITY_PROVIDER_ID = 'idp_sts';
    process.env.OPENAI_SERVICE_ACCOUNT_ID = 'sa_sts';
    process.env.OPENAI_WIF_AUDIENCE = 'aud-sts';
    stsSend.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });
    const tokenExchange = vi.fn(
      async (_url: string, _init: { body: string }) =>
        new Response(JSON.stringify({ access_token: 'openai-access-token', expires_in: 3600 }), { status: 200 })
    );
    vi.stubGlobal('fetch', tokenExchange);

    const backend = new OpenAIBackend(OPENAI_FEDERATED_KEY);
    expect(clientKey(backend)).toBeNull();
    const resolveBeforeSend = (backend as unknown as { clientForNextRequest(): Promise<{ token?: string }> })
      .clientForNextRequest;
    await expect(resolveBeforeSend.call(backend)).resolves.toMatchObject({ token: { value: 'openai-access-token' } });
    // The client only sends a token resolved before send, never exchanging inside a request.
    await expect(apiOf(backend)._options.apiKey()).rejects.toThrow(/resolved before send/);
    expect(stsSend).toHaveBeenCalledWith(
      { input: { Audience: ['aud-sts'], SigningAlgorithm: 'RS256' } },
      {
        abortSignal: expect.any(AbortSignal),
      }
    );
    expect(JSON.parse(tokenExchange.mock.calls[0][1].body)).toMatchObject({
      subject_token: 'sts-jwt',
      identity_provider_id: 'idp_sts',
      service_account_id: 'sa_sts',
    });
  });

  it.each([
    [60, 2],
    [3600, 1],
  ])(
    'exchanges again up front once under two minutes remain (expires_in %ss -> %s exchanges for two calls)',
    async (expiresIn, exchanges) => {
      process.env.PROVIDER_WIF_TOKEN_SOURCE = 'aws-sts';
      process.env.OPENAI_IDENTITY_PROVIDER_ID = 'idp_expiry';
      process.env.OPENAI_SERVICE_ACCOUNT_ID = 'sa_expiry';
      process.env.OPENAI_WIF_AUDIENCE = `aud-expiry-${expiresIn}`;
      stsSend.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });
      const tokenExchange = vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: 'openai-access-token', expires_in: expiresIn }), {
            status: 200,
          })
      );
      vi.stubGlobal('fetch', tokenExchange);
      const backend = new OpenAIBackend(OPENAI_FEDERATED_KEY);
      const resolveBeforeSend = (backend as unknown as { clientForNextRequest(): Promise<{ token?: string }> })
        .clientForNextRequest;
      await resolveBeforeSend.call(backend);
      await resolveBeforeSend.call(backend);
      expect(tokenExchange).toHaveBeenCalledTimes(exchanges);
    }
  );

  it.each([
    [20, 2],
    [3600, 1],
  ])(
    'exchanges again inside the request only when the call token would not outlive it (expires_in %ss -> %s)',
    async (expiresIn, exchanges) => {
      process.env.PROVIDER_WIF_TOKEN_SOURCE = 'aws-sts';
      process.env.OPENAI_IDENTITY_PROVIDER_ID = 'idp_retry';
      process.env.OPENAI_SERVICE_ACCOUNT_ID = 'sa_retry';
      process.env.OPENAI_WIF_AUDIENCE = `aud-retry-${expiresIn}`;
      stsSend.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });
      const tokenExchanges: string[] = [];
      const sentAuth: (string | null)[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === 'string' && init.body.includes('subject_token')) {
          tokenExchanges.push(String(input));
          const accessToken = `token-${tokenExchanges.length}`;
          return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), { status: 200 });
        }
        sentAuth.push(new Headers(init?.headers).get('authorization'));
        return new Response(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      });

      const backend = new OpenAIBackend(OPENAI_FEDERATED_KEY);
      await backend.complete('gpt-4o', [{ role: 'user', content: 'hi' }], { stream: false }, async () => {});

      expect(tokenExchanges).toHaveLength(exchanges);
      expect(sentAuth).toEqual([`Bearer token-${exchanges}`]);
    }
  );

  it('names the missing variables instead of failing later', () => {
    expect(() => new OpenAIBackend(OPENAI_FEDERATED_KEY)).toThrow(/OPENAI_IDENTITY_PROVIDER_ID/);
  });

  it('requests the GitHub identity token with the audience URL-encoded and the request token as bearer', async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.example/oidc?api-version=2.0';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'req-token';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: 'jwt-value' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(githubActionsIdToken('https://api.openai.com/v1')).resolves.toBe('jwt-value');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://token.example/oidc?api-version=2.0&audience=https%3A%2F%2Fapi.openai.com%2Fv1',
      { headers: { Authorization: 'Bearer req-token' }, signal: expect.any(AbortSignal) }
    );
  });

  it('fails clearly when the job has no id-token permission or the request is refused', async () => {
    await expect(githubActionsIdToken('aud')).rejects.toThrow(/id-token: write/);

    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.example/oidc?x=1';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'req-token';
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }));
    await expect(githubActionsIdToken('aud')).rejects.toThrow(/status 403/);
  });
});
