import { describe, it, expect } from 'vitest';
import { assignConsumptionFIFO, computeConsumption } from './creditLotAssignment';

describe('creditService - creditLotAssignment', () => {
  describe('computeConsumption', () => {
    it('is the total granted minus current credits', () => {
      expect(computeConsumption([{ amount: 100 }, { amount: 200 }], 250)).toBe(50);
    });

    it('clamps at zero when currentCredits exceeds total granted (e.g. an admin absolute-set top-up)', () => {
      expect(computeConsumption([{ amount: 100 }], 500)).toBe(0);
    });

    it('returns 0 for a holder with no lots', () => {
      expect(computeConsumption([], 100)).toBe(0);
    });
  });

  describe('assignConsumptionFIFO', () => {
    it('assigns consumption to the first (soonest-expiring) lot before touching later ones', () => {
      const lots = [{ amount: 100 }, { amount: 100 }, { amount: 100 }];
      const result = assignConsumptionFIFO(lots, 150);

      expect(result[0]).toMatchObject({ consumedAssigned: 100, remaining: 0 });
      expect(result[1]).toMatchObject({ consumedAssigned: 50, remaining: 50 });
      expect(result[2]).toMatchObject({ consumedAssigned: 0, remaining: 100 });
    });

    it('assigns nothing when consumption is zero', () => {
      const lots = [{ amount: 100 }, { amount: 100 }];
      const result = assignConsumptionFIFO(lots, 0);

      expect(result.every(r => r.consumedAssigned === 0)).toBe(true);
      expect(result.every((r, i) => r.remaining === lots[i].amount)).toBe(true);
    });

    it('fully assigns every lot when consumption exceeds the total', () => {
      const lots = [{ amount: 100 }, { amount: 100 }];
      const result = assignConsumptionFIFO(lots, 1000);

      expect(result.every(r => r.remaining === 0)).toBe(true);
      expect(result.reduce((sum, r) => sum + r.consumedAssigned, 0)).toBe(200);
    });

    it('clamps a negative consumption input to zero', () => {
      const lots = [{ amount: 100 }];
      const result = assignConsumptionFIFO(lots, -50);

      expect(result[0]).toMatchObject({ consumedAssigned: 0, remaining: 100 });
    });

    it('preserves the lot reference in each assignment', () => {
      const lot = { amount: 100 };
      const result = assignConsumptionFIFO([lot], 50);

      expect(result[0].lot).toBe(lot);
    });
  });
});
