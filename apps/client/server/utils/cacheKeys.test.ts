import { describe, expect, it } from 'vitest';

import { CacheKeys } from './cacheKeys';

/**
 * These expectations are pinned on purpose. The 12h caches key only on request
 * filters, so a change to a builder silently re-points every caller at a different
 * entry (or, worse, leaves it pointed at a payload the new code no longer produces).
 * If a change here fails, that is the prompt to bump the matching PAYLOAD_VERSIONS
 * entry in cacheKeys.ts rather than to update the string in place.
 */
describe('CacheKeys', () => {
  describe('versioned 12h keys', () => {
    it('pins the key for every versioned builder', () => {
      expect(CacheKeys.modelMetrics({})).toBe('model-metrics:v1:4f53cda18c2baa0c');
      expect(
        CacheKeys.modelMetrics({
          dateFrom: '2026-01-01',
          dateTo: '2026-01-31',
          userFilter: 'u1',
          modelFilter: 'gpt',
          statusFilter: 'completed',
        })
      ).toBe('model-metrics:v1:51d5aaf35280f540');

      expect(CacheKeys.spend({})).toBe('admin-spend:v2:4f53cda18c2baa0c');
      expect(
        CacheKeys.spend({ dateFrom: '2026-01-01', dateTo: '2026-01-31', userFilter: 'u1', modelFilter: 'gpt' })
      ).toBe('admin-spend:v2:2860ffe8a3ae5348');

      expect(CacheKeys.eventMetrics({})).toBe('event-metrics:v1:4f53cda18c2baa0c');
      expect(
        CacheKeys.eventMetrics({
          dateFrom: '2026-01-01',
          dateTo: '2026-01-31',
          userFilter: 'u1',
          eventFilter: 'e',
          eventCategoryFilter: 'Session',
        })
      ).toBe('event-metrics:v1:961641b10ffbc5f2');

      expect(CacheKeys.modelStats()).toBe('model-stats:v1');
    });

    it('carries a version segment on every 12h key, so a deploy can retire a projection', () => {
      // The point of the ticket: without this segment a changed projection keeps
      // serving pre-change payloads for up to 12h per warm filter combination.
      expect(CacheKeys.modelMetrics({})).toMatch(/^model-metrics:v\d+:/);
      expect(CacheKeys.spend({})).toMatch(/^admin-spend:v\d+:/);
      expect(CacheKeys.eventMetrics({})).toMatch(/^event-metrics:v\d+:/);
      expect(CacheKeys.modelStats()).toMatch(/^model-stats:v\d+$/);
    });
  });

  describe('filter normalization', () => {
    it('treats an empty filter as absent, so both share one entry', () => {
      expect(CacheKeys.modelMetrics({ userFilter: '' })).toBe(CacheKeys.modelMetrics({}));
      expect(CacheKeys.spend({ dateFrom: '', modelFilter: '' })).toBe(CacheKeys.spend({}));
      expect(CacheKeys.eventMetrics({ eventCategoryFilter: '' })).toBe(CacheKeys.eventMetrics({}));
    });

    it('is order-independent', () => {
      expect(CacheKeys.spend({ modelFilter: 'gpt', dateFrom: '2026-01-01' })).toBe(
        CacheKeys.spend({ dateFrom: '2026-01-01', modelFilter: 'gpt' })
      );
    });

    it('does not collide when a filter value contains the pair delimiter', () => {
      // Regression: joining "key:value" pairs on "|" let a crafted value stand in for
      // a second pair. spend was fixed for this; modelMetrics and eventMetrics were not.
      expect(CacheKeys.modelMetrics({ userFilter: 'a|modelFilter:b' })).not.toBe(
        CacheKeys.modelMetrics({ userFilter: 'a', modelFilter: 'b' })
      );
      expect(CacheKeys.eventMetrics({ userFilter: 'a|eventFilter:b' })).not.toBe(
        CacheKeys.eventMetrics({ userFilter: 'a', eventFilter: 'b' })
      );
    });

    it('ignores query params the projection does not read', () => {
      // Handlers hand over the rest of req.query; hashing an unrecognised param would
      // split the cache on something that cannot change the payload.
      const extra = { userFilter: 'u1', somethingElse: 'x' } as Parameters<typeof CacheKeys.modelMetrics>[0];
      expect(CacheKeys.modelMetrics(extra)).toBe(CacheKeys.modelMetrics({ userFilter: 'u1' }));
    });
  });

  describe('unversioned short-TTL keys', () => {
    it('leaves keys whose TTL is shorter than a deploy cycle untouched', () => {
      // Versioning these would discard caches that were about to refresh anyway.
      expect(CacheKeys.userInvites('u1', 10, 2)).toBe('userInvites:u1:10:2');
      expect(CacheKeys.modelList('u1')).toBe('model-list:u1');
      expect(CacheKeys.securityBehavioralSummary('u1')).toBe('security-behavioral-summary-v2:u1');
      expect(CacheKeys.securityDashboardAiAssessment('prod', 'abc')).toBe('security-dashboard-ai-assessment:prod:abc');
      expect(CacheKeys.refineText('hello')).toMatch(/^refine-text:[0-9a-f]{16}$/);
    });

    it('keys refineText on both text and context', () => {
      expect(CacheKeys.refineText('hello')).not.toBe(CacheKeys.refineText('hello', 'ctx'));
      expect(CacheKeys.refineText('hello', 'ctx')).toBe(CacheKeys.refineText('hello', 'ctx'));
    });
  });
});
