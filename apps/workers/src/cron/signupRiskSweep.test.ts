import { describe, it, expect, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/database', () => ({}));
vi.mock('@bike4mind/services', () => ({ userService: {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));

import { SIGNUP_RISK_WINDOW_DAYS, sweepSignupRiskScores } from './signupRiskSweep';

const NOW = new Date('2026-10-26T12:00:00Z');

/** A candidate list served in pages, the way findRiskScoringCandidateIds pages by id. */
const pagedUsers = (ids: string[]) => ({
  findRiskScoringCandidateIds: vi.fn(async (_since: Date, { afterId, limit }: { afterId?: string; limit: number }) => {
    const start = afterId ? ids.indexOf(afterId) + 1 : 0;
    return ids.slice(start, start + limit);
  }),
});

describe('sweepSignupRiskScores', () => {
  it('asks only for accounts inside the window', async () => {
    const users = pagedUsers([]);

    await sweepSignupRiskScores({ users, refresh: vi.fn(), now: NOW });

    const since = users.findRiskScoringCandidateIds.mock.calls[0][0];
    expect(NOW.getTime() - since.getTime()).toBe(SIGNUP_RISK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });

  it('rescores every candidate across pages, each once, continuing after the last id of a full page', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `u${String(i).padStart(4, '0')}`);
    const users = pagedUsers(ids);
    const refresh = vi.fn(async () => undefined);

    await expect(sweepSignupRiskScores({ users, refresh, now: NOW })).resolves.toBe(450);

    expect(refresh.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(users.findRiskScoringCandidateIds.mock.calls.map(([, page]) => page.afterId)).toEqual([
      undefined,
      'u0199',
      'u0399',
    ]);
  });

  it('stops after an exactly full last page with one empty read', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `u${String(i).padStart(4, '0')}`);
    const users = pagedUsers(ids);

    await expect(sweepSignupRiskScores({ users, refresh: vi.fn(async () => undefined), now: NOW })).resolves.toBe(200);
    expect(users.findRiskScoringCandidateIds).toHaveBeenCalledTimes(2);
  });
});
