import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repos = vi.hoisted(() => ({
  countPendingActionsBySessionIds: vi.fn(),
  findLatestReadyDecisionRefs: vi.fn(),
  findSessionIdsByUserId: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  questRepository: { countPendingActionsBySessionIds: repos.countPendingActionsBySessionIds },
  assistantBriefRepository: { findLatestReadyDecisionRefs: repos.findLatestReadyDecisionRefs },
  sessionRepository: { findSessionIdsByUserId: repos.findSessionIdsByUserId },
}));

import { countPendingDecisions } from './countPendingDecisions';

const NOW = 1_700_000_000_000;
const approval = (questId: string, sessionId: string) => ({ questId, sessionId, pendingActionTs: 1 });

describe('countPendingDecisions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repos.countPendingActionsBySessionIds.mockResolvedValue(0);
    repos.findLatestReadyDecisionRefs.mockResolvedValue(null);
    repos.findSessionIdsByUserId.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is zero with no open approval and no ready brief', async () => {
    await expect(countPendingDecisions('owner', NOW)).resolves.toEqual({
      count: 0,
      approvals: 0,
      briefDecisions: 0,
      briefId: null,
    });
  });

  it("counts approvals in the caller's own sessions inside the 15 minute answer window", async () => {
    repos.findSessionIdsByUserId.mockResolvedValue(['s1', 's2']);
    repos.countPendingActionsBySessionIds.mockResolvedValue(2);

    const result = await countPendingDecisions('owner', NOW);

    expect(repos.findSessionIdsByUserId).toHaveBeenCalledWith('owner');
    expect(repos.countPendingActionsBySessionIds).toHaveBeenCalledWith(['s1', 's2'], NOW - 15 * 60 * 1000);
    expect(repos.findLatestReadyDecisionRefs).toHaveBeenCalledWith('owner');
    expect(result).toMatchObject({ count: 2, approvals: 2 });
  });

  it('counts a brief approval decision only through the open approvals', async () => {
    repos.countPendingActionsBySessionIds.mockResolvedValue(1);
    repos.findLatestReadyDecisionRefs.mockResolvedValue({
      _id: { toString: () => 'brief-1' },
      decisions: [{}, { approval: approval('open', 's1') }, { approval: approval('answered', 's1') }, {}],
    });

    await expect(countPendingDecisions('owner', NOW)).resolves.toEqual({
      count: 3,
      approvals: 1,
      briefDecisions: 2,
      briefId: 'brief-1',
    });
  });

  it('drops a brief question already answered from the brief', async () => {
    repos.findLatestReadyDecisionRefs.mockResolvedValue({
      _id: { toString: () => 'brief-1' },
      decisions: [{}, { repliedAt: new Date(NOW) }],
    });

    await expect(countPendingDecisions('owner', NOW)).resolves.toMatchObject({ count: 1, briefDecisions: 1 });
  });

  it('counts a follow-up decision only while it is pending', async () => {
    repos.findLatestReadyDecisionRefs.mockResolvedValue({
      _id: { toString: () => 'brief-1' },
      decisions: [
        { followUp: { state: 'pending' } },
        { followUp: { state: 'approved' } },
        { followUp: { state: 'dismissed' } },
      ],
    });

    await expect(countPendingDecisions('owner', NOW)).resolves.toMatchObject({ count: 1, briefDecisions: 1 });
  });

  it('propagates a failed read instead of answering a partial count', async () => {
    repos.findSessionIdsByUserId.mockRejectedValue(new Error('db down'));

    await expect(countPendingDecisions('owner', NOW)).rejects.toThrow('db down');
  });

  it('defaults the window to the current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    await countPendingDecisions('owner');

    expect(repos.countPendingActionsBySessionIds).toHaveBeenCalledWith([], NOW - 15 * 60 * 1000);
  });
});
