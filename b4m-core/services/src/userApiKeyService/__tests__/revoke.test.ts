import { describe, it, expect, vi } from 'vitest';
import { createUserApiKey } from '../create';
import { revokeUserApiKey } from '../revoke';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

// In-memory store wiring create -> revoke so we can assert the status flip.
function makeSyncedRepo() {
  let stored: IUserApiKeyDocument | null = null;
  const repo = {
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    countActiveByProductId: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation((doc: Record<string, unknown>) => {
      stored = { ...doc, id: 'key-1', createdAt: new Date() } as unknown as IUserApiKeyDocument;
      return Promise.resolve(stored);
    }),
    findByUserIdAndId: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    update: vi.fn().mockResolvedValue(undefined),
  };
  return { repo, getStored: () => stored };
}

describe('revokeUserApiKey', () => {
  it('disables an embed:chat key while leaving its embed fields intact', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    await createUserApiKey(
      'user1',
      {
        name: 'Embed key',
        scopes: [ApiKeyScope.EMBED_CHAT],
        metadata: { createdFrom: 'dashboard' as const },
        agentId: 'agent-1',
        allowedOrigins: ['https://example.com'],
      },
      adapters
    );

    await revokeUserApiKey('user1', { keyId: 'key-1' }, adapters);

    expect(getStored()!.status).toBe(ApiKeyStatus.DISABLED);
    expect(getStored()!.agentId).toBe('agent-1');
  });
});
