import { describe, expect, it } from 'vitest';
import { isCalendarDate, settingsMap } from './settings';

describe('QuestMasterLegacyShutdownDate', () => {
  const { schema } = settingsMap.QuestMasterLegacyShutdownDate;

  it('accepts an empty value or a real calendar date', () => {
    expect(schema.safeParse('').success).toBe(true);
    expect(schema.safeParse('2027-01-31').success).toBe(true);
  });

  it('rejects anything else', () => {
    for (const value of ['2027-02-30', '2027-1-31', 'January 31, 2027', '2027-01-31T00:00:00Z']) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it('isCalendarDate rejects impossible days', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
  });
});
