import { describe, expect, it, vi } from 'vitest';
import { rotateUserApiKey } from '../rotate';
import { resolveOwnedApiKey } from '../resolveOwnedApiKey';
import type { IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

describe('service key lifecycle', () => {
  it('preserves the non-human principal when an org admin rotates', async () => {
    const key = {
      id: 'key',
      userId: 'service-principal',
      serviceAccount: true,
      scopes: [],
    } as unknown as IUserApiKeyDocument;
    const update = vi.fn();
    const userApiKeys = {
      findByUserIdAndId: vi.fn().mockResolvedValue(null),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(key),
      update,
    } as unknown as IUserApiKeyRepository;
    const result = await rotateUserApiKey(
      'admin',
      { keyId: 'key' },
      {
        serviceAccountManagement: true,
        db: {
          userApiKeys,
          organizations: { findIdsAdministeredBy: vi.fn().mockResolvedValue(['org']) },
        },
      }
    );
    expect(key.userId).toBe('service-principal');
    expect(update.mock.calls[0][0]).not.toHaveProperty('userId');
    expect(result.previousOwnerUserId).toBeUndefined();
  });
  it('does not let the service principal manage its own key', async () => {
    const userApiKeys = {
      findByUserIdAndId: vi.fn().mockResolvedValue({ serviceAccount: true }),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
    } as unknown as IUserApiKeyRepository;
    expect(
      await resolveOwnedApiKey('service', 'key', {
        db: { userApiKeys, organizations: { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) } },
      })
    ).toBeNull();
  });
});
