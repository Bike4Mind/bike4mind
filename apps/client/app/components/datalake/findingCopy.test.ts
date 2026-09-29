import { describe, it, expect } from 'vitest';
import { INCONSISTENCY_KINDS, LAKE_FINDING_DETECTORS, LAKE_FINDING_STATUSES } from '@bike4mind/common';
import {
  FINDING_DETECTOR_LABEL,
  FINDING_KIND_HINT,
  FINDING_KIND_LABEL,
  FINDING_STATUS_LABEL,
  formatFindingDate,
  hasRecurredSinceResolution,
} from './findingCopy';

describe('findingCopy', () => {
  // A kind with no label renders `undefined` in a filter option, which is how a new detector rule
  // would reach a curator as a blank row rather than as anything they could act on.
  it('labels and explains every kind the detector can produce', () => {
    for (const kind of INCONSISTENCY_KINDS) {
      expect(FINDING_KIND_LABEL[kind]).toBeTruthy();
      expect(FINDING_KIND_HINT[kind]).toBeTruthy();
    }
    for (const status of LAKE_FINDING_STATUSES) expect(FINDING_STATUS_LABEL[status]).toBeTruthy();
    for (const detector of LAKE_FINDING_DETECTORS) expect(FINDING_DETECTOR_LABEL[detector]).toBeTruthy();
  });

  describe('hasRecurredSinceResolution', () => {
    it('is false for a finding nobody has ruled on', () => {
      expect(hasRecurredSinceResolution({ lastSeenAt: new Date('2026-03-01'), resolvedAt: null })).toBe(false);
    });

    it('is false when the last sighting predates the ruling', () => {
      expect(
        hasRecurredSinceResolution({ lastSeenAt: new Date('2026-02-01'), resolvedAt: new Date('2026-03-01') })
      ).toBe(false);
    });

    it('is true when the detector has seen the problem since it was ruled on', () => {
      expect(
        hasRecurredSinceResolution({ lastSeenAt: new Date('2026-04-01'), resolvedAt: new Date('2026-03-01') })
      ).toBe(true);
    });

    // Dates cross the wire as ISO strings despite the `Date` in the type, so a comparison that only
    // worked on real Dates would silently never fire on the surface it exists for.
    it('compares ISO strings as the API actually sends them', () => {
      expect(
        hasRecurredSinceResolution({
          lastSeenAt: '2026-04-01T00:00:00.000Z' as unknown as Date,
          resolvedAt: '2026-03-01T00:00:00.000Z' as unknown as Date,
        })
      ).toBe(true);
    });
  });

  describe('formatFindingDate', () => {
    it('reports a missing or unparseable date rather than rendering "Invalid Date"', () => {
      expect(formatFindingDate(null)).toBe('unknown');
      expect(formatFindingDate('not a date')).toBe('unknown');
    });

    it('formats an ISO string', () => {
      expect(formatFindingDate('2026-03-05T00:00:00.000Z')).not.toBe('unknown');
    });
  });
});
