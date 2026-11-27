import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const queries: { collection: string; filter: Record<string, unknown>; fields?: Record<string, number> }[] = [];
  const model = (collection: string) => ({
    find: (filter: Record<string, unknown>) => {
      const query = { collection, filter } as (typeof queries)[number];
      queries.push(query);
      return {
        select: (fields: Record<string, number>) => {
          query.fields = fields;
          return { sort: () => ({ lean: async () => [] }) };
        },
      };
    },
  });
  return { queries, model };
});

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    find: (filter: Record<string, unknown>, options: Record<string, unknown>) => {
      mocks.queries.push({ collection: 'agent', filter, fields: options });
      return Promise.resolve([]);
    },
  },
  CodeAgentEvent: mocks.model('event'),
  CreditLot: mocks.model('lot'),
  CreditTransaction: mocks.model('transaction'),
  ToolExecutionLog: mocks.model('tool'),
  UsageEvent: mocks.model('usage'),
  UserApiKeyAuditLog: mocks.model('key'),
  UserAuthAuditLogModel: mocks.model('auth'),
}));
vi.mock('@bike4mind/services', async () => ({
  accountArchiveHistoryService: await import('../../../../b4m-core/services/src/accountArchive/history'),
}));

import { collectAccountHistoryFromDatabase } from './accountArchiveHistory';

describe('account archive history database adapter', () => {
  it('scopes all reads and projects only export fields', async () => {
    await collectAccountHistoryFromDatabase('owner');
    expect(mocks.queries).toHaveLength(8);
    for (const query of mocks.queries) {
      expect(Object.values(query.filter)).toContain('owner');
      expect(query.fields).toMatchObject({ _id: 0 });
      expect(query.fields).not.toHaveProperty('metadata');
      expect(query.fields).not.toHaveProperty('text');
      expect(query.fields).not.toHaveProperty('query');
      expect(query.fields).not.toHaveProperty('details');
    }
    expect(mocks.queries.find(query => query.collection === 'usage')?.filter).toEqual({
      ownerId: 'owner',
      ownerType: 'User',
      userId: 'owner',
    });
    expect(mocks.queries.find(query => query.collection === 'transaction')?.filter).toEqual({
      ownerId: 'owner',
      ownerType: 'User',
    });
    expect(mocks.queries.find(query => query.collection === 'key')?.filter).toEqual({ actorUserId: 'owner' });
  });
});
