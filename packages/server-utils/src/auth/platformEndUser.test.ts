import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, BadRequestError } from '@bike4mind/common';
import { toPlatformEndUserProviderId, toProviderEndUserId } from '@bike4mind/llm-adapters';

const recordSeen = vi.fn();
vi.mock('@bike4mind/database', () => ({
  platformEndUserRepository: { recordSeen: (...args: unknown[]) => recordSeen(...args) },
}));

import { recordPlatformEndUserSeen, resolvePlatformEndUser } from './platformEndUser';

const OWNER = '507f1f77bcf86cd799439011';
const platformKey = { keyId: 'key-1', scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_END_USER_ID] };
const asPlatform = { userId: OWNER, apiKeyInfo: platformKey };

describe('resolvePlatformEndUser', () => {
  it('is undefined when no end_user_id was sent, whatever the credential', () => {
    expect(resolvePlatformEndUser(undefined, { userId: undefined, apiKeyInfo: undefined })).toBeUndefined();
    expect(
      resolvePlatformEndUser(undefined, {
        userId: OWNER,
        apiKeyInfo: { ...platformKey, scopes: [ApiKeyScope.AI_CHAT] },
      })
    ).toBeUndefined();
  });

  it('maps a platform key end user to the namespaced identifier and its lookup row', () => {
    const endUser = resolvePlatformEndUser('customer_42', asPlatform);
    expect(endUser?.providerEndUserId).toBe(toPlatformEndUserProviderId(OWNER, 'customer_42'));
    expect(endUser?.providerEndUserId).not.toBe(toProviderEndUserId(OWNER));
    expect(endUser?.record).toEqual({
      providerEndUserId: endUser?.providerEndUserId,
      keyOwnerId: OWNER,
      apiKeyId: 'key-1',
      endUserId: 'customer_42',
    });
  });

  it.each([
    ['a key without ai:end-user-id', { ...platformKey, scopes: [ApiKeyScope.AI_CHAT] }],
    ['a session (no API key)', undefined],
  ])('refuses end_user_id from %s with a 400 end_user_id_not_allowed', (_label, apiKeyInfo) => {
    let thrown: unknown;
    try {
      resolvePlatformEndUser('customer_42', { userId: OWNER, apiKeyInfo });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).additionalInfo).toEqual({ errorCode: 'end_user_id_not_allowed' });
  });
});

describe('resolvePlatformEndUser format check', () => {
  it.each([
    ['empty', ''],
    ['over 64 characters', 'a'.repeat(65)],
    ['outside the charset', 'customer 42'],
    ['an email', 'jane@example.com'],
  ])('refuses an end_user_id that is %s with a 400 invalid_end_user_id', (_label, value) => {
    for (const caller of [asPlatform, { userId: OWNER, apiKeyInfo: undefined }]) {
      let thrown: unknown;
      try {
        resolvePlatformEndUser(value, caller);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestError);
      expect((thrown as BadRequestError).additionalInfo).toEqual({ errorCode: 'invalid_end_user_id' });
    }
  });
});

describe('recordPlatformEndUserSeen', () => {
  beforeEach(() => {
    recordSeen.mockReset();
  });

  it('writes the lookup row', async () => {
    recordSeen.mockResolvedValue(undefined);
    const endUser = resolvePlatformEndUser('customer_42', asPlatform)!;
    await recordPlatformEndUserSeen(endUser, { warn: vi.fn() });
    expect(recordSeen).toHaveBeenCalledWith(endUser.record);
  });

  it('logs and swallows a failed write', async () => {
    recordSeen.mockRejectedValue(new Error('db down'));
    const warn = vi.fn();
    await expect(
      recordPlatformEndUserSeen(resolvePlatformEndUser('customer_42', asPlatform)!, { warn })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[platformEndUser] Failed to record end user', {
      apiKeyId: 'key-1',
      error: 'db down',
    });
  });
});
