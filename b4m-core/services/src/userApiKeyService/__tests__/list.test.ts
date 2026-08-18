import { describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';
import { listAgentEmbedKeys } from '../list';

function key(overrides: Partial<IUserApiKeyDocument>): IUserApiKeyDocument {
  return {
    id: 'key-1',
    status: 'active',
    scopes: [ApiKeyScope.EMBED_CHAT],
    agentId: 'agent-1',
    ...overrides,
  } as unknown as IUserApiKeyDocument;
}

function adapters(keys: IUserApiKeyDocument[]) {
  const findByAgentId = vi.fn().mockResolvedValue(keys);
  return {
    adapters: { db: { userApiKeys: { findByAgentId } as unknown as IUserApiKeyRepository } },
    findByAgentId,
  };
}

describe('listAgentEmbedKeys', () => {
  it('returns the agent-bound embed keys via the agent finder', async () => {
    const { adapters: a, findByAgentId } = adapters([key({ id: 'key-1' }), key({ id: 'key-2' })]);
    const result = await listAgentEmbedKeys('agent-1', a);
    expect(findByAgentId).toHaveBeenCalledWith('agent-1');
    expect(result.map(k => k.id)).toEqual(['key-1', 'key-2']);
  });

  it('drops a non-embed key that carries a stray agentId (scope filter is defensive)', async () => {
    const { adapters: a } = adapters([
      key({ id: 'embed' }),
      key({ id: 'stray', scopes: ['chat:completions' as ApiKeyScope] }),
    ]);
    const result = await listAgentEmbedKeys('agent-1', a);
    expect(result.map(k => k.id)).toEqual(['embed']);
  });

  it('returns empty for an agent with no keys', async () => {
    const { adapters: a } = adapters([]);
    await expect(listAgentEmbedKeys('agent-1', a)).resolves.toEqual([]);
  });
});
