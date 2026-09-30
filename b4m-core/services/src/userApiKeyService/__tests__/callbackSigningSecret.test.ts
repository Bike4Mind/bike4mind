import { describe, it, expect, vi } from 'vitest';
import { rotateCallbackSigningSecret } from '../callbackSigningSecret';
import { ApiKeyScope } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';

describe('rotateCallbackSigningSecret', () => {
  it('throws NotFound when the caller did not mint the key', async () => {
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(null),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await expect(rotateCallbackSigningSecret('other-user', { keyId: 'key-1' }, adapters)).rejects.toThrow(/not found/);
    expect(repo.setCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('throws Forbidden when the API-key caller is missing one of the target key scopes', async () => {
    const stored = {
      id: 'key-1',
      name: 'Escalation target',
      userId: 'minter',
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_NOTEBOOKS],
    } as unknown as IUserApiKeyDocument;
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(stored),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };

    const adapters = {
      db: { userApiKeys: repo as any },
      callerScopes: [ApiKeyScope.AI_CHAT],
    };

    await expect(rotateCallbackSigningSecret('minter', { keyId: 'key-1' }, adapters)).rejects.toThrow(/does not have/);
    expect(repo.setCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('succeeds when the API-key caller scopes are a superset of the target key scopes', async () => {
    const stored = {
      id: 'key-1',
      name: 'Subset target',
      userId: 'minter',
      scopes: [ApiKeyScope.AI_CHAT],
    } as unknown as IUserApiKeyDocument;
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(stored),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };

    const adapters = {
      db: { userApiKeys: repo as any },
      callerScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_NOTEBOOKS],
    };

    const result = await rotateCallbackSigningSecret('minter', { keyId: 'key-1' }, adapters);

    expect(result.callbackSigningSecret).toMatch(/^whsec_/);
    expect(repo.setCallbackSigningSecret).toHaveBeenCalledWith(
      'key-1',
      expect.stringMatching(/^whsec_/),
      expect.any(Date)
    );
  });

  it('succeeds when the API-key caller scopes exactly equal the target key scopes', async () => {
    const stored = {
      id: 'key-1',
      name: 'Equal target',
      userId: 'minter',
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_NOTEBOOKS],
    } as unknown as IUserApiKeyDocument;
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(stored),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };

    const adapters = {
      db: { userApiKeys: repo as any },
      callerScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_NOTEBOOKS],
    };

    await expect(rotateCallbackSigningSecret('minter', { keyId: 'key-1' }, adapters)).resolves.toBeDefined();
    expect(repo.setCallbackSigningSecret).toHaveBeenCalled();
  });

  it('a JWT/browser caller (no callerScopes) always succeeds regardless of the target key scopes', async () => {
    const stored = {
      id: 'key-1',
      name: 'Any scopes',
      userId: 'minter',
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_FILES],
    } as unknown as IUserApiKeyDocument;
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(stored),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    const result = await rotateCallbackSigningSecret('minter', { keyId: 'key-1' }, adapters);

    expect(result.callbackSigningSecret).toMatch(/^whsec_/);
    expect(repo.setCallbackSigningSecret).toHaveBeenCalled();
  });

  it('returns id, name, secret, and createdAt on success', async () => {
    const stored = {
      id: 'key-1',
      name: 'My key',
      userId: 'minter',
      scopes: [ApiKeyScope.AI_CHAT],
    } as unknown as IUserApiKeyDocument;
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(stored),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    const result = await rotateCallbackSigningSecret('minter', { keyId: 'key-1' }, adapters);

    expect(result.id).toBe('key-1');
    expect(result.name).toBe('My key');
    expect(result.callbackSigningSecret).toMatch(/^whsec_/);
    expect(result.callbackSigningSecretCreatedAt).toBeInstanceOf(Date);
    expect(repo.setCallbackSigningSecret).toHaveBeenCalledWith(
      'key-1',
      result.callbackSigningSecret,
      result.callbackSigningSecretCreatedAt
    );
  });

  it('refuses an org admin who did not mint the key, without consulting org administration', async () => {
    const stored = {
      id: 'key-1',
      name: 'Org embed key',
      userId: 'minter',
      scopes: [ApiKeyScope.AI_CHAT],
    } as unknown as IUserApiKeyDocument;
    const repo = {
      findByUserIdAndId: vi.fn().mockResolvedValue(null),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(stored),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await expect(rotateCallbackSigningSecret('admin-user', { keyId: 'key-1' }, adapters)).rejects.toThrow(/not found/);
    expect(repo.findByUserIdAndId).toHaveBeenCalledWith('admin-user', 'key-1');
    expect(repo.findByOrganizationIdsAndId).not.toHaveBeenCalled();
    expect(repo.setCallbackSigningSecret).not.toHaveBeenCalled();
  });
});
