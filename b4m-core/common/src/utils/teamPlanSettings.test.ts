import { describe, it, expect } from 'vitest';
import { resolveLowCreditsThreshold, resolveTeamPlanSettings } from './teamPlanSettings';
import { LOW_CREDITS_THRESHOLD_DEFAULT, settingsMap, userReadableSettingKeys } from '../schemas/settings';
import {
  ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT,
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  TEAM_PLAN_SEATS_HARD_LIMIT,
} from '../constants/organization';

describe('team plan settings', () => {
  describe('schema defaults match the constants they replace', () => {
    it.each([
      ['teamPlanMinSeats', ORGANIZATION_SUBSCRIPTION_MIN_SEATS, 4],
      ['teamPlanMaxSeats', ORGANIZATION_SUBSCRIPTION_MAX_SEATS, 100],
      ['teamPlanCreditsPerSeat', ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT, 50000],
      ['lowCreditsThreshold', LOW_CREDITS_THRESHOLD_DEFAULT, 1000],
    ] as const)('%s defaults to %d', (key, constant, literal) => {
      expect(constant).toBe(literal);
      expect(settingsMap[key].defaultValue).toBe(constant);
      expect(settingsMap[key].schema.parse(undefined)).toBe(constant);
      expect(settingsMap[key].schema.parse('')).toBe(constant);
    });
  });

  describe('schema validation', () => {
    it('rejects fractional and out-of-range seat counts', () => {
      expect(settingsMap.teamPlanMinSeats.schema.safeParse(0).success).toBe(false);
      expect(settingsMap.teamPlanMinSeats.schema.safeParse(2.5).success).toBe(false);
      expect(settingsMap.teamPlanMaxSeats.schema.safeParse(TEAM_PLAN_SEATS_HARD_LIMIT + 1).success).toBe(false);
      expect(settingsMap.teamPlanMaxSeats.schema.safeParse('250').success).toBe(true);
    });

    it('rejects negative credit values but allows a zero threshold', () => {
      expect(settingsMap.teamPlanCreditsPerSeat.schema.safeParse(-1).success).toBe(false);
      expect(settingsMap.lowCreditsThreshold.schema.safeParse(-1).success).toBe(false);
      expect(settingsMap.lowCreditsThreshold.schema.parse(0)).toBe(0);
    });

    it('lets non-admins read only the knobs client code needs', () => {
      const readable = new Set(userReadableSettingKeys());
      expect(readable.has('teamPlanMinSeats')).toBe(true);
      expect(readable.has('teamPlanMaxSeats')).toBe(true);
      expect(readable.has('lowCreditsThreshold')).toBe(true);
      expect(readable.has('teamPlanCreditsPerSeat')).toBe(false);
    });
  });

  describe('resolveTeamPlanSettings', () => {
    it('returns the historical constants when nothing is stored', () => {
      expect(resolveTeamPlanSettings({})).toEqual({
        minSeats: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
        maxSeats: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
        creditsPerSeat: ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT,
      });
    });

    it('reads stored string and number values', () => {
      expect(
        resolveTeamPlanSettings({ teamPlanMinSeats: '2', teamPlanMaxSeats: 250, teamPlanCreditsPerSeat: '75000' })
      ).toEqual({ minSeats: 2, maxSeats: 250, creditsPerSeat: 75000 });
    });

    it('treats the null the server cache returns for an absent key, or a blank value, as unset', () => {
      expect(
        resolveTeamPlanSettings({ teamPlanMinSeats: null, teamPlanMaxSeats: '', teamPlanCreditsPerSeat: null })
      ).toEqual({
        minSeats: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
        maxSeats: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
        creditsPerSeat: ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT,
      });
      expect(resolveLowCreditsThreshold(null)).toBe(LOW_CREDITS_THRESHOLD_DEFAULT);
    });

    it('rejects a fractional seat count', () => {
      expect(resolveTeamPlanSettings({ teamPlanMinSeats: '2.5' }).minSeats).toBe(ORGANIZATION_SUBSCRIPTION_MIN_SEATS);
    });

    it('falls back per key when a stored value is invalid', () => {
      expect(resolveTeamPlanSettings({ teamPlanMinSeats: 'abc', teamPlanMaxSeats: -5 })).toEqual({
        minSeats: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
        maxSeats: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
        creditsPerSeat: ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT,
      });
    });

    it('clamps a floor above the ceiling down to the ceiling', () => {
      const { minSeats, maxSeats } = resolveTeamPlanSettings({ teamPlanMinSeats: 20, teamPlanMaxSeats: 10 });
      expect(maxSeats).toBe(10);
      expect(minSeats).toBe(10);
    });
  });

  describe('resolveLowCreditsThreshold', () => {
    it('defaults, reads, and rejects garbage', () => {
      expect(resolveLowCreditsThreshold(undefined)).toBe(LOW_CREDITS_THRESHOLD_DEFAULT);
      expect(resolveLowCreditsThreshold('5000')).toBe(5000);
      expect(resolveLowCreditsThreshold(0)).toBe(0);
      expect(resolveLowCreditsThreshold('lots')).toBe(LOW_CREDITS_THRESHOLD_DEFAULT);
    });
  });
});
