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
  _options: { workloadIdentity: { provider: { getToken: () => Promise<string> } } };
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

  it('takes the subject token from STS under PROVIDER_WIF_TOKEN_SOURCE=aws-sts', async () => {
    process.env.PROVIDER_WIF_TOKEN_SOURCE = 'aws-sts';
    process.env.OPENAI_IDENTITY_PROVIDER_ID = 'idp_sts';
    process.env.OPENAI_SERVICE_ACCOUNT_ID = 'sa_sts';
    process.env.OPENAI_WIF_AUDIENCE = 'aud-sts';
    stsSend.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });

    const backend = new OpenAIBackend(OPENAI_FEDERATED_KEY);
    expect(clientKey(backend)).toBeNull();
    await expect(apiOf(backend)._options.workloadIdentity.provider.getToken()).resolves.toBe('sts-jwt');
    expect(stsSend).toHaveBeenCalledWith({ input: { Audience: ['aud-sts'], SigningAlgorithm: 'RS256' } });
  });

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
      { headers: { Authorization: 'Bearer req-token' } }
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
