import { afterEach, describe, expect, it, vi } from 'vitest';
import { briefWindow, cachedFormatterCount, computeNextBriefAt, type BriefScheduleTiming } from './briefSchedule';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const schedule = (overrides: Partial<BriefScheduleTiming>): BriefScheduleTiming => ({
  enabled: true,
  timeOfDay: '08:00',
  days: ALL_DAYS,
  timeZone: 'UTC',
  ...overrides,
});

const cases: Array<[string, Partial<BriefScheduleTiming>, string, string | null]> = [
  [
    'later today in New York',
    { timeZone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    '2026-11-18T12:00:00Z',
    '2026-11-18T13:00:00.000Z',
  ],
  [
    'a slot that just fired advances',
    { timeZone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    '2026-11-18T13:00:00Z',
    '2026-11-19T13:00:00.000Z',
  ],
  [
    'Friday rolls over the weekend',
    { timeZone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    '2026-11-20T14:00:00Z',
    '2026-11-23T13:00:00.000Z',
  ],
  [
    'a single day seven days out',
    { timeZone: 'America/New_York', days: [3] },
    '2026-11-18T14:00:00Z',
    '2026-11-25T13:00:00.000Z',
  ],
  [
    'spring-forward gap resolves forward',
    { timeZone: 'America/New_York', days: [0], timeOfDay: '02:30' },
    '2026-03-07T12:00:00Z',
    '2026-03-08T07:30:00.000Z',
  ],
  [
    'fall-back fold fires the earlier instant',
    { timeZone: 'America/New_York', days: [0], timeOfDay: '01:30' },
    '2026-10-31T12:00:00Z',
    '2026-11-01T05:30:00.000Z',
  ],
  [
    'fold slot already fired does not fire again that day',
    { timeZone: 'America/New_York', days: [0], timeOfDay: '01:30' },
    '2026-11-01T05:30:00Z',
    '2026-11-08T06:30:00.000Z',
  ],
  [
    'half-hour offset (Kolkata +5:30)',
    { timeZone: 'Asia/Kolkata', timeOfDay: '09:00' },
    '2026-11-18T00:00:00Z',
    '2026-11-18T03:30:00.000Z',
  ],
  [
    'quarter-hour offset (Kathmandu +5:45)',
    { timeZone: 'Asia/Kathmandu', timeOfDay: '09:00' },
    '2026-11-18T00:00:00Z',
    '2026-11-18T03:15:00.000Z',
  ],
  [
    '+14 zone is a local day ahead',
    { timeZone: 'Pacific/Kiritimati' },
    '2026-11-18T00:00:00Z',
    '2026-11-18T18:00:00.000Z',
  ],
  [
    'weekday is the local one, not UTC',
    { timeZone: 'Pacific/Kiritimati', days: [4] },
    '2026-11-18T00:00:00Z',
    '2026-11-18T18:00:00.000Z',
  ],
  [
    '-11 zone is a local day behind',
    { timeZone: 'Pacific/Pago_Pago' },
    '2026-11-18T00:00:00Z',
    '2026-11-18T19:00:00.000Z',
  ],
  ['disabled', { enabled: false }, '2026-11-18T00:00:00Z', null],
  ['no days', { days: [] }, '2026-11-18T00:00:00Z', null],
];

describe('computeNextBriefAt', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(cases)('%s', (_label, overrides, after, expected) => {
    expect(computeNextBriefAt(schedule(overrides), new Date(after))?.toISOString() ?? null).toBe(expected);
  });

  it('ignores the process time zone', () => {
    const run = () =>
      cases.map(([, overrides, after]) => computeNextBriefAt(schedule(overrides), new Date(after))?.getTime());
    const baseline = run();
    vi.stubEnv('TZ', 'Pacific/Auckland');
    expect(run()).toEqual(baseline);
  });
});

describe('briefWindow', () => {
  const now = new Date('2026-11-18T12:00:00Z');

  it('covers the last day when there is no ready brief', () => {
    expect(briefWindow(null, now)).toEqual({ periodStart: new Date('2026-11-17T12:00:00Z'), periodEnd: now });
  });

  it('starts at the end of the last ready brief', () => {
    const latest = new Date('2026-11-15T08:00:00Z');
    expect(briefWindow(latest, now).periodStart).toEqual(latest);
  });

  it('caps the window at a week', () => {
    expect(briefWindow(new Date('2026-10-01T00:00:00Z'), now).periodStart).toEqual(new Date('2026-11-11T12:00:00Z'));
  });
});

describe('zone formatter cache', () => {
  it('adds no entry for case variants of a cached zone and computes the same instant', () => {
    const after = new Date('2026-11-18T12:00:00Z');
    const canonical = computeNextBriefAt(schedule({ timeZone: 'Asia/Kolkata' }), after);
    const size = cachedFormatterCount();

    for (const variant of ['asia/kolkata', 'ASIA/KOLKATA', 'aSiA/kOlKaTa']) {
      expect(computeNextBriefAt(schedule({ timeZone: variant }), after)).toEqual(canonical);
    }
    expect(cachedFormatterCount()).toBe(size);
  });

  it('rejects a non-ASCII look-alike of a cached zone instead of reusing its entry', () => {
    const after = new Date('2026-11-18T12:00:00Z');
    computeNextBriefAt(schedule({ timeZone: 'Asia/Kolkata' }), after);
    const size = cachedFormatterCount();

    expect(() => computeNextBriefAt(schedule({ timeZone: 'Asia/\u212Aolkata' }), after)).toThrow(RangeError);
    expect(cachedFormatterCount()).toBe(size);
  });
});
