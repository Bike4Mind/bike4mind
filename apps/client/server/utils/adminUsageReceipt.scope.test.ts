import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ eventFind: vi.fn(), ledgerFind: vi.fn(), keyFind: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  UsageEvent: { find: mocks.eventFind },
  CreditTransaction: { find: mocks.ledgerFind },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findById: mocks.keyFind } }));

import { loadUsageReceipt } from './adminUsageReceipt';

const emptyQuery = () => {
  const query = {
    select: vi.fn(() => query),
    sort: vi.fn(() => query),
    limit: vi.fn(() => query),
    maxTimeMS: vi.fn(() => query),
    lean: vi.fn(async () => []),
  };
  return query;
};

describe('loadUsageReceipt account scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventFind.mockReturnValue(emptyQuery());
    mocks.ledgerFind.mockReturnValue(emptyQuery());
  });

  it('keeps actorless platform costs out of a user receipt even with the same request id', async () => {
    const receipt = await loadUsageReceipt('real-user', 'shared-request', new Date('2026-11-25T00:00:00Z'));

    expect(mocks.eventFind).toHaveBeenCalledWith({
      userId: 'real-user',
      requestId: 'shared-request',
      createdAt: {
        $gte: new Date('2026-11-24T00:00:00Z'),
        $lte: new Date('2026-11-26T00:00:00Z'),
      },
    });
    expect(mocks.ledgerFind).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'real-user', ownerType: 'User' }));
    expect(mocks.keyFind).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      requestId: 'shared-request',
      calls: [],
      ledger: [],
      totals: { cost: 0, charged: 0, writtenOff: 0 },
    });
  });
});
