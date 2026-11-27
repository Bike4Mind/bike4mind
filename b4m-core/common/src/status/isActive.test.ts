import { describe, expect, it } from 'vitest';
import { isActive, type ActivityFacts } from './isActive';

const now = new Date('2026-11-23T12:00:00Z');
const incident = (overrides: Partial<ActivityFacts> = {}): ActivityFacts => ({
  kind: 'incident',
  published: true,
  status: 'investigating',
  ...overrides,
});
const maintenance = (overrides: Partial<ActivityFacts> = {}): ActivityFacts => ({
  kind: 'maintenance',
  published: true,
  status: 'scheduled',
  scheduledStartAt: '2026-11-23T11:00:00Z',
  scheduledEndAt: '2026-11-23T13:00:00Z',
  ...overrides,
});

describe('isActive', () => {
  const table: [string, ActivityFacts, boolean][] = [
    ['open incident', incident(), true],
    ['monitoring incident', incident({ status: 'monitoring' }), true],
    ['resolved status', incident({ status: 'resolved' }), false],
    ['resolvedAt set', incident({ resolvedAt: '2026-11-23T11:30:00Z' }), false],
    ['draft incident', incident({ published: false }), false],
    ['retracted incident', incident({ retracted: { at: 'x' } }), false],
    ['maintenance in window', maintenance(), true],
    ['maintenance before window', maintenance({ scheduledStartAt: '2026-11-23T12:00:01Z' }), false],
    ['maintenance exactly at start', maintenance({ scheduledStartAt: '2026-11-23T12:00:00Z' }), true],
    ['maintenance exactly at end', maintenance({ scheduledEndAt: '2026-11-23T12:00:00Z' }), false],
    ['maintenance after window', maintenance({ scheduledEndAt: '2026-11-23T11:59:59Z' }), false],
    [
      'maintenance completed early',
      maintenance({ status: 'completed', completedEarlyAt: '2026-11-23T11:30:00Z' }),
      false,
    ],
    ['early completion in the future is the end', maintenance({ completedEarlyAt: '2026-11-23T12:30:00Z' }), true],
    ['maintenance cancelled by status', maintenance({ status: 'cancelled' }), false],
    ['maintenance cancelled by timestamp', maintenance({ cancelledAt: '2026-11-23T10:00:00Z' }), false],
    ['unpublished maintenance', maintenance({ published: false }), false],
    ['retracted maintenance', maintenance({ retracted: true }), false],
    ['maintenance without schedule', maintenance({ scheduledStartAt: null, scheduledEndAt: null }), false],
    ['maintenance without an end', maintenance({ scheduledEndAt: null }), false],
  ];

  it.each(table)('%s', (_name, facts, expected) => {
    expect(isActive(facts, now)).toBe(expected);
  });

  it('accepts Date, ISO and epoch inputs for now', () => {
    expect(isActive(maintenance(), now.getTime())).toBe(true);
    expect(isActive(maintenance(), '2026-11-23T12:00:00Z')).toBe(true);
    expect(isActive(maintenance(), 'not a date')).toBe(false);
  });

  it('accepts Date objects for schedule fields', () => {
    expect(
      isActive(
        maintenance({
          scheduledStartAt: new Date('2026-11-23T11:00:00Z'),
          scheduledEndAt: new Date('2026-11-23T13:00:00Z'),
        }),
        now
      )
    ).toBe(true);
  });
});
