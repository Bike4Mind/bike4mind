import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatContract, executeToolContract, ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const verifyApiKey = vi.fn();
const verifyJwtToken = vi.fn();
vi.mock('./auth', () => ({
  verifyApiKey: (...args: unknown[]) => verifyApiKey(...args),
  verifyJwtToken: (...args: unknown[]) => verifyJwtToken(...args),
}));

import { resolveContractAuth } from './resolveContractAuth';

const headers = { authorization: 'Bearer b4m_live_key' };

describe('resolveContractAuth', () => {
  beforeEach(() => {
    verifyApiKey.mockReset().mockResolvedValue({ userId: 'u1' });
    verifyJwtToken.mockReset().mockResolvedValue({ id: 'u2' });
  });

  it('gates the api key on the contract-declared scopes (not verifyApiKey defaults)', async () => {
    await resolveContractAuth(headers, chatContract);
    expect(verifyApiKey).toHaveBeenCalledWith(headers, {
      requiredScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
    });
  });

  it('falls back to undefined requiredScopes when the contract declares none', async () => {
    // A synthetic apiKeyOrJwt contract with no scopes must not send an empty array
    // (verifyApiKey treats [] and its default differently).
    const scopeless = { ...chatContract, scopes: undefined };
    await resolveContractAuth(headers, scopeless);
    expect(verifyApiKey).toHaveBeenCalledWith(headers, { requiredScopes: undefined });
  });

  it('falls through to JWT when the api key is rejected', async () => {
    verifyApiKey.mockRejectedValueOnce(new Error('Invalid or expired API key'));
    const result = await resolveContractAuth(headers, chatContract);
    expect(result).toEqual({ method: 'jwt', userId: 'u2', user: { id: 'u2' } });
  });

  it('surfaces a forbidden key owner over the JWT failure when both fail', async () => {
    const forbidden = new ForbiddenError('Account suspended');
    verifyApiKey.mockRejectedValueOnce(forbidden);
    verifyJwtToken.mockRejectedValueOnce(new Error('Invalid authorization token'));
    await expect(resolveContractAuth(headers, chatContract)).rejects.toBe(forbidden);
  });

  it('still serves a valid JWT when the key owner is forbidden', async () => {
    verifyApiKey.mockRejectedValueOnce(new ForbiddenError('Account suspended'));
    const result = await resolveContractAuth(headers, chatContract);
    expect(result).toEqual({ method: 'jwt', userId: 'u2', user: { id: 'u2' } });
  });

  it('reports the JWT error when the key failure is not a 403', async () => {
    const jwtError = new Error('Invalid authorization token');
    verifyApiKey.mockRejectedValueOnce(new Error('Invalid or expired API key'));
    verifyJwtToken.mockRejectedValueOnce(jwtError);
    await expect(resolveContractAuth(headers, chatContract)).rejects.toBe(jwtError);
  });

  it('runs JWT only for a jwtOnly contract, never touching verifyApiKey', async () => {
    const result = await resolveContractAuth(headers, executeToolContract);
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(result).toEqual({ method: 'jwt', userId: 'u2', user: { id: 'u2' } });
  });
});
