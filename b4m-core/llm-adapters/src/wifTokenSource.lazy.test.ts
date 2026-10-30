import { afterEach, describe, expect, it, vi } from 'vitest';

const sts = vi.hoisted(() => ({ loads: 0, send: vi.fn() }));
vi.mock('@aws-sdk/client-sts', () => {
  sts.loads++;
  return {
    STSClient: vi.fn().mockImplementation(function () {
      return { send: sts.send };
    }),
    GetWebIdentityTokenCommand: vi.fn().mockImplementation(function (input: unknown) {
      return { input };
    }),
  };
});

import { OPENAI_FEDERATED_KEY, OpenAIBackend } from './openaiBackend';
import { awsStsIdToken, githubActionsIdToken } from './wifTokenSource';

describe('lazy @aws-sdk/client-sts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is not loaded by importing the package or using the github-actions source', async () => {
    vi.stubEnv('OPENAI_IDENTITY_PROVIDER_ID', 'idp_lazy');
    vi.stubEnv('OPENAI_SERVICE_ACCOUNT_ID', 'sa_lazy');
    vi.stubEnv('OPENAI_WIF_AUDIENCE', 'aud-lazy');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://token.example/oidc?x=1');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'req-token');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ value: 'gh-jwt' }), { status: 200 }));

    new OpenAIBackend(OPENAI_FEDERATED_KEY);
    await expect(githubActionsIdToken('aud')).resolves.toBe('gh-jwt');

    expect(sts.loads).toBe(0);
  });

  it('loads once, on the first aws-sts token request', async () => {
    sts.send.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });
    await awsStsIdToken('aud');
    await awsStsIdToken('aud');
    expect(sts.loads).toBe(1);
  });
});
