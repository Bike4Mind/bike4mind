import { describe, expect, it, vi } from 'vitest';
import { collectAccountHistory, type AccountHistoryReaders } from './history';

describe('collectAccountHistory', () => {
  it('exports only own records and allowlisted scalar fields', async () => {
    const secret = 'private-tool-argument';
    const otherUser = 'other-user-id';
    const readers: AccountHistoryReaders = {
      toolExecutions: vi.fn(async () => [
        {
          userId: 'owner',
          toolName: 'search',
          timestamp: new Date('2025-01-01'),
          success: true,
          executionTimeMs: 5,
          error: secret,
          args: { apiKey: secret },
        },
        { userId: otherUser, toolName: 'other-tool' },
      ]),
      agentExecutions: vi.fn(async () => [
        { userId: 'owner', status: 'completed', totalCreditsUsed: 3, query: secret, result: otherUser },
        { userId: otherUser, status: 'failed' },
      ]),
      codeAgentEvents: vi.fn(async () => [
        { userId: 'owner', type: 'tool_use', text: secret, tool: secret, instanceId: otherUser },
        { userId: otherUser, type: 'message' },
      ]),
      creditTransactions: vi.fn(async () => [
        {
          ownerId: 'owner',
          ownerType: 'User',
          type: 'purchase',
          credits: 50,
          metadata: { token: secret },
          senderId: otherUser,
          description: otherUser,
        },
        { ownerId: 'owner', ownerType: 'Organization', credits: 99 },
        { ownerId: otherUser, ownerType: 'User', credits: 99 },
      ]),
      creditLots: vi.fn(async () => [
        { ownerId: 'owner', ownerType: 'User', amount: 50, stripeRef: secret },
        { ownerId: otherUser, ownerType: 'User', amount: 99 },
      ]),
      usageEvents: vi.fn(async () => [
        { ownerId: 'owner', ownerType: 'User', userId: 'owner', creditsCharged: 2, requestMeta: secret },
        { ownerId: 'owner', ownerType: 'User', userId: otherUser, creditsCharged: 3 },
        { ownerId: otherUser, ownerType: 'User', userId: 'owner', creditsCharged: 4 },
      ]),
      authAudit: vi.fn(async () => [
        { userId: 'owner', event: 'login', actorUserId: otherUser, actorIp: secret, metadata: { secret } },
        { userId: otherUser, event: 'logout' },
      ]),
      apiKeyAudit: vi.fn(async () => [
        { actorUserId: 'owner', action: 'mint', keyId: secret, details: { secret } },
        { actorUserId: otherUser, action: 'revoke' },
      ]),
    };
    const result = await collectAccountHistory('owner', readers);
    expect(result).toEqual({
      toolExecutions: [
        { toolName: 'search', timestamp: '2025-01-01T00:00:00.000Z', success: true, executionTimeMs: 5 },
      ],
      agentExecutions: [{ status: 'completed', totalCreditsUsed: 3 }],
      codeAgentEvents: [{ type: 'tool_use' }],
      creditTransactions: [{ type: 'purchase', credits: 50 }],
      creditLots: [{ amount: 50 }],
      usageEvents: [{ creditsCharged: 2 }],
      authAudit: [{ event: 'login' }],
      apiKeyAudit: [{ action: 'mint' }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(otherUser);
    for (const reader of Object.values(readers)) expect(reader).toHaveBeenCalledWith('owner');
  });

  it('rejects an empty account id before reading anything', async () => {
    const read = vi.fn(async () => []);
    const readers = Object.fromEntries(
      [
        'toolExecutions',
        'agentExecutions',
        'codeAgentEvents',
        'creditTransactions',
        'creditLots',
        'usageEvents',
        'authAudit',
        'apiKeyAudit',
      ].map(key => [key, read])
    ) as AccountHistoryReaders;
    await expect(collectAccountHistory('', readers)).rejects.toThrow('Account id is required');
    expect(read).not.toHaveBeenCalled();
  });
});
