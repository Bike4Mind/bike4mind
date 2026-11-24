import { describe, expect, it, vi } from 'vitest';
import { expireInterventionHolds } from './expiry';

const NOW = new Date('2026-11-01T00:00:00Z');

describe('expireInterventionHolds', () => {
  it('marks the decisions whose holds lapsed expired', async () => {
    const users = { expireInterventionHolds: vi.fn().mockResolvedValue(['d1', 'd2']) };
    const decisions = { markExpired: vi.fn().mockResolvedValue(2) };

    await expect(expireInterventionHolds(NOW, { users, decisions })).resolves.toEqual({ holds: 2, decisions: 2 });
    expect(users.expireInterventionHolds).toHaveBeenCalledWith(NOW);
    expect(decisions.markExpired).toHaveBeenCalledWith(['d1', 'd2'], NOW);
  });

  it('touches no decision when nothing lapsed', async () => {
    const users = { expireInterventionHolds: vi.fn().mockResolvedValue([]) };
    const decisions = { markExpired: vi.fn() };

    await expect(expireInterventionHolds(NOW, { users, decisions })).resolves.toEqual({ holds: 0, decisions: 0 });
    expect(decisions.markExpired).not.toHaveBeenCalled();
  });
});
