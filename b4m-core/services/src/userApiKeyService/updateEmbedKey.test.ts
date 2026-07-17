import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateEmbedKey } from './updateEmbedKey';
import { ApiKeyScope, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

// Seed a stored key and echo mutations back so we can assert what was persisted.
const makeRepo = (stored: Partial<IUserApiKeyDocument> | null) =>
  ({
    findByUserIdAndId: vi.fn().mockResolvedValue(stored),
    update: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IUserApiKeyRepository;

const embedKey = (): Partial<IUserApiKeyDocument> => ({
  id: 'key-1',
  name: 'Embed key',
  scopes: [ApiKeyScope.EMBED_CHAT],
  agentId: 'agent-1',
  allowedOrigins: ['https://example.com'],
  branding: { displayName: 'Acme Assistant' },
});

describe('userApiKeyService - updateEmbedKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only the provided fields, leaving the rest intact', async () => {
    const stored = embedKey();
    const repo = makeRepo(stored);

    const result = await updateEmbedKey('user1', { keyId: 'key-1', agentId: 'agent-2' }, { db: { userApiKeys: repo } });

    expect(result.agentId).toBe('agent-2');
    expect(result.allowedOrigins).toEqual(['https://example.com']);
    expect(result.branding).toEqual({ displayName: 'Acme Assistant' });
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-2' }));
  });

  it('normalizes and dedupes a replacement origin list', async () => {
    const repo = makeRepo(embedKey());

    const result = await updateEmbedKey(
      'user1',
      { keyId: 'key-1', allowedOrigins: ['https://A.example.com', 'https://a.example.com'] },
      { db: { userApiKeys: repo } }
    );

    expect(result.allowedOrigins).toEqual(['https://a.example.com']);
  });

  it('clears the allow-list when given an empty array', async () => {
    const repo = makeRepo(embedKey());

    const result = await updateEmbedKey('user1', { keyId: 'key-1', allowedOrigins: [] }, { db: { userApiKeys: repo } });

    expect(result.allowedOrigins).toEqual([]);
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigins: [] }));
  });

  it('replaces the branding fields', async () => {
    const repo = makeRepo(embedKey());

    const result = await updateEmbedKey(
      'user1',
      { keyId: 'key-1', branding: { displayName: 'New Name', primaryColor: '#336699' } },
      { db: { userApiKeys: repo } }
    );

    expect(result.branding).toEqual({ displayName: 'New Name', primaryColor: '#336699' });
  });

  it('rejects configuring a key without the embed:chat scope', async () => {
    const repo = makeRepo({ ...embedKey(), scopes: [ApiKeyScope.AI_CHAT] });

    await expect(
      updateEmbedKey('user1', { keyId: 'key-1', agentId: 'agent-2' }, { db: { userApiKeys: repo } })
    ).rejects.toThrow(/Only embed:chat keys/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('throws NotFound when the key does not belong to the user', async () => {
    const repo = makeRepo(null);

    await expect(
      updateEmbedKey('user1', { keyId: 'key-1', agentId: 'agent-2' }, { db: { userApiKeys: repo } })
    ).rejects.toThrow(/not found/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed origin', async () => {
    const repo = makeRepo(embedKey());

    await expect(
      updateEmbedKey('user1', { keyId: 'key-1', allowedOrigins: ['http://example.com'] }, { db: { userApiKeys: repo } })
    ).rejects.toThrow(/normalized https origin/);
    expect(repo.update).not.toHaveBeenCalled();
  });
});
