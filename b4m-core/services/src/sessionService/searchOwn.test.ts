import { describe, expect, it, vi } from 'vitest';
import { MAX_SESSION_LIST_LIMIT } from '@bike4mind/common';
import { searchOwnSessions } from './searchOwn';

const adapters = () => {
  const searchByUserId = vi.fn().mockResolvedValue({ data: [], hasMore: false });
  return { searchByUserId, db: { sessions: { searchByUserId } } };
};

describe('searchOwnSessions', () => {
  it('clamps an oversized page to the list maximum instead of rejecting it', async () => {
    const { searchByUserId, db } = adapters();
    await searchOwnSessions('u1', { pagination: { page: 2, limit: 5000 } }, { db });
    expect(searchByUserId.mock.calls[0][2].pagination).toEqual({ page: 2, limit: MAX_SESSION_LIST_LIMIT });
  });

  it('keeps a page within the maximum as asked, and defaults to lastUpdated desc', async () => {
    const { searchByUserId, db } = adapters();
    await searchOwnSessions('u1', { pagination: { page: 1, limit: 30 } }, { db });
    expect(searchByUserId.mock.calls[0][2]).toEqual({
      pagination: { page: 1, limit: 30 },
      orderBy: { field: 'lastUpdated', direction: 'desc' },
    });
  });

  it('passes the keyset through to the repository', async () => {
    const { searchByUserId, db } = adapters();
    const after = { id: '65f000000000000000000001', at: new Date('2026-01-01T00:00:00.000Z') };
    await searchOwnSessions('u1', {}, { db }, { after });
    expect(searchByUserId.mock.calls[0][5]).toEqual({ after });
  });
});
