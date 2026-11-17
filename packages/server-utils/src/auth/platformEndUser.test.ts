import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';

const { recordSeen } = vi.hoisted(() => ({ recordSeen: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ providerEndUserMappingRepository: { recordSeen } }));

import { recordPlatformEndUser, resolvePlatformEndUser } from './platformEndUser';

const OWNER = '507f1f77bcf86cd799439011';
const PLATFORM_KEY = { ownerUserId: OWNER, scopes: [ApiKeyScope.AI_GENERATE, ApiKeyScope.AI_END_USER_ATTRIBUTION] };

describe('resolvePlatformEndUser', () => {
  it('returns undefined when no end_user_id was sent, whoever the caller is', () => {
    expect(resolvePlatformEndUser(undefined, undefined)).toBeUndefined();
    expect(resolvePlatformEndUser(undefined, { ownerUserId: OWNER, scopes: [] })).toBeUndefined();
  });

  it('namespaces the end user under the key owner for a key holding the scope', () => {
    expect(resolvePlatformEndUser('player-42', PLATFORM_KEY)).toEqual({
      ownerUserId: OWNER,
      endUserId: 'player-42',
      attributionId: `${OWNER}:player-42`,
    });
  });

  it('refuses a JWT caller with a 400', () => {
    expect(() => resolvePlatformEndUser('player-42', undefined)).toThrow(
      expect.objectContaining({ statusCode: 400, message: expect.stringContaining('ai:end-user-attribution') })
    );
  });

  it('refuses a key without the scope with a 400', () => {
    expect(() =>
      resolvePlatformEndUser('player-42', { ownerUserId: OWNER, scopes: [ApiKeyScope.AI_GENERATE] })
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('recordPlatformEndUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts the digest the providers receive', () => {
    recordSeen.mockResolvedValue(undefined);
    const endUser = resolvePlatformEndUser('player-42', PLATFORM_KEY)!;
    recordPlatformEndUser(endUser, { warn: vi.fn() });
    expect(recordSeen).toHaveBeenCalledWith({
      providerEndUserId: toProviderEndUserId(`${OWNER}:player-42`),
      ownerUserId: OWNER,
      endUserId: 'player-42',
    });
  });

  it('logs a failed write instead of throwing', async () => {
    recordSeen.mockRejectedValue(new Error('db down'));
    const warn = vi.fn();
    expect(() => recordPlatformEndUser(resolvePlatformEndUser('p', PLATFORM_KEY)!, { warn })).not.toThrow();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'db down' }))
    );
  });
});
