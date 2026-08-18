import { vi, describe, it, expect } from 'vitest';
import { createApiKey } from './create';
import { ApiKeyType } from '@bike4mind/common';
import type { IApiKeyDocument, IApiKeyRepository } from '@bike4mind/common';

// Records both deactivation methods so the type-scoped one can be asserted as the only
// one reached - deactivating by user id alone is what stranded every other provider's key.
const makeRepo = () => ({
  create: vi.fn(async (doc: unknown) => doc as IApiKeyDocument),
  updateAllByUserIdAndType: vi.fn(async () => undefined),
  updateAllByUserId: vi.fn(async () => undefined),
});

const params = (over: Partial<Parameters<typeof createApiKey>[1]> = {}) =>
  ({
    apiKey: 'key-value-1234',
    type: ApiKeyType.openai,
    description: '',
    isActive: true,
    expireDays: 90,
    ...over,
  }) as Parameters<typeof createApiKey>[1];

const run = (repo: ReturnType<typeof makeRepo>, over?: Partial<Parameters<typeof createApiKey>[1]>) =>
  createApiKey('user-1', params(over), {
    db: { apiKeys: repo as unknown as Pick<IApiKeyRepository, 'create' | 'updateAllByUserIdAndType'> },
  });

describe('createApiKey', () => {
  it('scopes the deactivation to the new key type', async () => {
    const repo = makeRepo();

    await run(repo, { type: ApiKeyType.openai });

    expect(repo.updateAllByUserIdAndType).toHaveBeenCalledWith('user-1', ApiKeyType.openai, { isActive: false });
  });

  it('never deactivates by user id alone, which would strand every other provider', async () => {
    const repo = makeRepo();

    await run(repo, { type: ApiKeyType.openai });

    expect(repo.updateAllByUserId).not.toHaveBeenCalled();
  });

  it('leaves another provider type untouched (the reported bug)', async () => {
    const repo = makeRepo();

    await run(repo, { type: ApiKeyType.openai });

    const types = repo.updateAllByUserIdAndType.mock.calls.map(([, type]) => type);
    expect(types).toEqual([ApiKeyType.openai]);
    expect(types).not.toContain(ApiKeyType.elevenlabs);
  });

  it('still supersedes an existing key of the same type', async () => {
    const repo = makeRepo();

    await run(repo, { type: ApiKeyType.elevenlabs });

    expect(repo.updateAllByUserIdAndType).toHaveBeenCalledWith('user-1', ApiKeyType.elevenlabs, { isActive: false });
  });

  it('deactivates nothing when the new key is created inactive', async () => {
    const repo = makeRepo();

    await run(repo, { isActive: false });

    expect(repo.updateAllByUserIdAndType).not.toHaveBeenCalled();
    expect(repo.updateAllByUserId).not.toHaveBeenCalled();
  });

  it('persists the key with its type, owner and an expiry derived from expireDays', async () => {
    const repo = makeRepo();

    await run(repo, { type: ApiKeyType.voyageai, expireDays: 1 });

    const [doc] = repo.create.mock.calls[0] as [IApiKeyDocument];
    expect(doc.userId).toBe('user-1');
    expect(doc.type).toBe(ApiKeyType.voyageai);
    expect(doc.isActive).toBe(true);
    expect(doc.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
