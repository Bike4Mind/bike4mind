import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENAI_FEDERATED_KEY, OpenAIBackend, githubActionsIdToken } from './openaiBackend';

const ENV_NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_IDENTITY_PROVIDER_ID',
  'OPENAI_SERVICE_ACCOUNT_ID',
  'OPENAI_WIF_AUDIENCE',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];

const clientKey = (backend: OpenAIBackend) => (backend as unknown as { _api: { apiKey: string | null } })._api.apiKey;

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
