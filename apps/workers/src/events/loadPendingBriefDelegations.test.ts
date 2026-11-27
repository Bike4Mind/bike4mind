import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ failStale: vi.fn(), listUnbriefed: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  delegatedItemRepository: { failStale: mocks.failStale, listUnbriefed: mocks.listUnbriefed },
}));

import { DELEGATION_STALE_MS, loadPendingBriefDelegations } from './loadPendingBriefDelegations';

describe('loadPendingBriefDelegations', () => {
  it('fails stale pending items before listing the unbriefed ones', async () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const end = new Date('2026-11-19T11:00:00Z');
    mocks.listUnbriefed.mockResolvedValue([{ intent: 'x' }]);

    expect(await loadPendingBriefDelegations('u1', end, now)).toEqual([{ intent: 'x' }]);
    expect(mocks.failStale).toHaveBeenCalledWith('u1', new Date(now.getTime() - DELEGATION_STALE_MS), now);
    expect(mocks.listUnbriefed).toHaveBeenCalledWith('u1', end, 36, undefined);
    expect(mocks.failStale.mock.invocationCallOrder[0]).toBeLessThan(mocks.listUnbriefed.mock.invocationCallOrder[0]);
  });
});
