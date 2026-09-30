import { vi, describe, it, expect } from 'vitest';
import { setApiKey } from './set';
import { ApiKeyType, NotFoundError } from '@bike4mind/common';
import type { IApiKeyDocument } from '@bike4mind/common';

const storedKey = () =>
  ({
    id: 'key-1',
    userId: 'user-1',
    type: ApiKeyType.openai,
    apiKey: 'encrypted-secret',
    description: 'mine',
    isActive: false,
  }) as unknown as IApiKeyDocument;

const makeRepo = (found: IApiKeyDocument | null = storedKey()) => ({
  findByIdAndUserIdAndType: vi.fn(async () => found),
  updateAllByUserIdAndType: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
});

describe('setApiKey', () => {
  it('writes only the activation flag, never the stored secret', async () => {
    const repo = makeRepo();

    const result = await setApiKey('user-1', { id: 'key-1', type: ApiKeyType.openai }, { db: { apiKeys: repo } });

    expect(repo.findByIdAndUserIdAndType).toHaveBeenCalledWith('key-1', 'user-1', ApiKeyType.openai);
    expect(repo.updateAllByUserIdAndType).toHaveBeenCalledWith('user-1', ApiKeyType.openai, { isActive: false });
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({ id: 'key-1', isActive: true });
    expect(result.isActive).toBe(true);
  });

  it('throws NotFoundError and writes nothing when the key is not the caller own', async () => {
    const repo = makeRepo(null);

    await expect(
      setApiKey('user-1', { id: 'key-1', type: ApiKeyType.openai }, { db: { apiKeys: repo } })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.updateAllByUserIdAndType).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });
});
