import { describe, expect, it } from 'vitest';
import { BriefScheduleSchema } from './brief';

const valid = { enabled: true, timeOfDay: '08:00', days: [1, 2, 3, 4, 5], timeZone: 'America/New_York' };

describe('BriefScheduleSchema', () => {
  it.each([
    ['a weekday schedule', valid],
    ['midnight and every day', { ...valid, timeOfDay: '00:00', days: [0, 1, 2, 3, 4, 5, 6] }],
    ['the last minute of the day', { ...valid, timeOfDay: '23:59' }],
    ['a disabled schedule', { ...valid, enabled: false }],
  ])('accepts %s', (_label, body) => {
    expect(BriefScheduleSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['empty body', {}],
    ['no days', { ...valid, days: [] }],
    ['repeated days', { ...valid, days: [1, 1] }],
    ['days not an array', { ...valid, days: 1 }],
    ['a weekday out of range', { ...valid, days: [7] }],
    ['a fractional weekday', { ...valid, days: [1.5] }],
    ['24:00', { ...valid, timeOfDay: '24:00' }],
    ['unpadded time', { ...valid, timeOfDay: '7:5' }],
    ['12-hour time', { ...valid, timeOfDay: '08:00 AM' }],
    ['an unknown zone', { ...valid, timeZone: 'Mars/Base' }],
    ['a bare offset', { ...valid, timeZone: '+05:30' }],
    ['an empty zone', { ...valid, timeZone: '' }],
    ['enabled as a string', { ...valid, enabled: 'true' }],
  ])('rejects %s', (_label, body) => {
    expect(BriefScheduleSchema.safeParse(body).success).toBe(false);
  });
});
