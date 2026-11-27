import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/teamPlanSettings', () => ({
  getTeamPlanSettings: async () => ({ creditsPerSeat: 1000 }),
}));

vi.mock('./constants', () => ({
  findSubscriptionPlan: (priceId: string) => (priceId === 'price_pro' ? { credits: 50000 } : undefined),
}));

import { planCreditsPerCycle } from './planCreditsPerCycle';

describe('planCreditsPerCycle', () => {
  it("returns an individual plan's allotment", async () => {
    expect(await planCreditsPerCycle({ ownerType: 'User', priceId: 'price_pro', quantity: 1 })).toBe(50000);
  });

  it('returns null for an unknown or missing individual price', async () => {
    expect(await planCreditsPerCycle({ ownerType: 'User', priceId: 'price_other', quantity: 1 })).toBeNull();
    expect(await planCreditsPerCycle({ ownerType: 'User', priceId: undefined, quantity: 1 })).toBeNull();
  });

  it("multiplies the Team plan's per-seat allotment by seats", async () => {
    expect(await planCreditsPerCycle({ ownerType: 'Organization', priceId: 'price_team', quantity: 3 })).toBe(3000);
  });
});
