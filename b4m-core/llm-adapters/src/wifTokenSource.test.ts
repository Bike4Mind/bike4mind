import { afterEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(function () {
    return { send };
  }),
  GetWebIdentityTokenCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
}));

import { awsStsIdToken, githubActionsIdToken, selectedWifTokenSource, subjectTokenSource } from './wifTokenSource';

describe('selectedWifTokenSource', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to github-actions when unset or blank', () => {
    vi.stubEnv('PROVIDER_WIF_TOKEN_SOURCE', '');
    expect(selectedWifTokenSource()).toBe('github-actions');
  });

  it('selects aws-sts and returns the matching source', () => {
    vi.stubEnv('PROVIDER_WIF_TOKEN_SOURCE', 'aws-sts');
    expect(selectedWifTokenSource()).toBe('aws-sts');
    expect(subjectTokenSource()).toBe(awsStsIdToken);
    expect(subjectTokenSource('github-actions')).toBe(githubActionsIdToken);
  });

  it('rejects an unknown source instead of falling back silently', () => {
    vi.stubEnv('PROVIDER_WIF_TOKEN_SOURCE', 'gcp');
    expect(() => selectedWifTokenSource()).toThrow(/Unknown PROVIDER_WIF_TOKEN_SOURCE "gcp"/);
  });
});

describe('awsStsIdToken', () => {
  afterEach(() => send.mockReset());

  it('asks STS for a token scoped to the audience and returns the JWT', async () => {
    send.mockResolvedValue({ WebIdentityToken: 'sts-jwt' });
    await expect(awsStsIdToken('https://aud.example')).resolves.toBe('sts-jwt');
    expect(send).toHaveBeenCalledWith({
      input: { Audience: ['https://aud.example'], SigningAlgorithm: 'RS256' },
    });
  });

  it('fetches a fresh token on every call', async () => {
    send.mockResolvedValueOnce({ WebIdentityToken: 'a' }).mockResolvedValueOnce({ WebIdentityToken: 'b' });
    expect(await awsStsIdToken('aud')).toBe('a');
    expect(await awsStsIdToken('aud')).toBe('b');
  });

  it('fails when STS returns no token', async () => {
    send.mockResolvedValue({});
    await expect(awsStsIdToken('aud')).rejects.toThrow(/returned no token/);
  });
});
