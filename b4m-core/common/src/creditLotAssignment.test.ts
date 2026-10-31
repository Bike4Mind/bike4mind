import { describe, it, expect } from 'vitest';
import { assignConsumptionFIFO, attributeChargeToFundingSources, computeConsumption } from './creditLotAssignment';

describe('creditLotAssignment', () => {
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

  describe('attributeChargeToFundingSources', () => {
    it('attributes a charge inside one lot to that lot', () => {
      const lots = [{ amount: 100, source: 'promo' as const }];
      expect(attributeChargeToFundingSources(lots, 70, 30)).toEqual({
        granted: 30,
        purchased: 0,
        subscription: 0,
        unknown: 0,
      });
    });

    it('splits a charge that crosses a lot boundary', () => {
      // 120 consumed: the promo lot is spent, and this charge of 50 took 30 from promo and 20 from the pack.
      const lots = [
        { amount: 100, source: 'promo' as const },
        { amount: 500, source: 'pack' as const },
      ];
      expect(attributeChargeToFundingSources(lots, 480, 50)).toEqual({
        granted: 30,
        purchased: 20,
        subscription: 0,
        unknown: 0,
      });
    });

    it('maps subscription, transfer and legacy lots', () => {
      const lots = [
        { amount: 10, source: 'subscription' as const },
        { amount: 10, source: 'transfer' as const },
        { amount: 10, source: 'legacy' as const },
      ];
      expect(attributeChargeToFundingSources(lots, 0, 30)).toEqual({
        granted: 10,
        purchased: 0,
        subscription: 10,
        unknown: 10,
      });
    });

    it('marks credits beyond every lot unknown when the holder is in debt', () => {
      const lots = [{ amount: 100, source: 'promo' as const }];
      expect(attributeChargeToFundingSources(lots, -50, 80)).toEqual({
        granted: 30,
        purchased: 0,
        subscription: 0,
        unknown: 50,
      });
    });

    it('marks credits unknown when the lots under-count the balance', () => {
      // Balance 500 against 100 of lots: consumption clamps to 0, so no lot accounts for the charge.
      const lots = [{ amount: 100, source: 'pack' as const }];
      expect(attributeChargeToFundingSources(lots, 500, 40)).toEqual({
        granted: 0,
        purchased: 0,
        subscription: 0,
        unknown: 40,
      });
    });

    it('marks the whole charge unknown when the holder has no lots', () => {
      expect(attributeChargeToFundingSources([], 0, 25)).toEqual({
        granted: 0,
        purchased: 0,
        subscription: 0,
        unknown: 25,
      });
    });

    it("uses a lot's funding override over its source", () => {
      // An admin-comped subscription: a subscription lot nobody paid for.
      const lots = [{ amount: 100, source: 'subscription' as const, fundingSource: 'granted' as const }];
      expect(attributeChargeToFundingSources(lots, 60, 40)).toEqual({
        granted: 40,
        purchased: 0,
        subscription: 0,
        unknown: 0,
      });
    });

    it('leaves out lots the sweep settled, so a refund cannot reopen expired credits', () => {
      // Promo 100 expired and was settled (its remainder debited); pack 500 holds a balance of 530
      // after a refund. Without the skip, consumption 70 would land the charge in the expired promo.
      const lots = [
        { amount: 100, source: 'promo' as const, settledAt: new Date('2026-10-01T00:00:00Z') },
        { amount: 500, source: 'pack' as const },
      ];
      expect(attributeChargeToFundingSources(lots, 480, 20)).toEqual({
        granted: 0,
        purchased: 20,
        subscription: 0,
        unknown: 0,
      });
    });

    it('returns an empty breakdown for a non-positive charge', () => {
      const lots = [{ amount: 100, source: 'promo' as const }];
      expect(attributeChargeToFundingSources(lots, 50, -5)).toEqual({
        granted: 0,
        purchased: 0,
        subscription: 0,
        unknown: 0,
      });
    });
  });
});
