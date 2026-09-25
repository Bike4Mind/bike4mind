import { describe, it, expect } from 'vitest';
import { isTagAttemptDue, tagAttemptDueFilter, TAG_RETRY_BACKOFF_MS } from './SessionTypes';

/**
 * These two express one rule in two languages: `isTagAttemptDue` gates what the spider dispatches
 * (apps/client/server/events/spider.ts) and `tagAttemptDueFilter` gates what the credit pre-flight
 * prices (sessionRepository.countTaggableNotebooks). A disagreement between them re-opens the
 * dispatch-vs-settlement gap the counter exists to close.
 *
 * Asserted here rather than through Mongo because the counter resolves its own `Date.now()`, which
 * moves past a stamp a test just wrote before the query runs - so the exact edge is unobservable
 * from an integration test, and a boundary test written there passes against either operator.
 */
describe('tagging retry gate', () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

  /**
   * Applies Mongo's own semantics to whichever comparison the filter emitted, so swapping `$lte`
   * for `$lt` changes this result rather than being silently re-interpreted by the test.
   */
  const dueArms = (now: number) => tagAttemptDueFilter(now).$and[0].$or;

  const filterMatches = (stamp: Date, now: number): boolean => {
    const arm = dueArms(now)[1].tagLastAttemptAt as Record<string, Date>;
    const [operator, bound] = Object.entries(arm)[0];
    if (operator === '$lte') return stamp.getTime() <= bound.getTime();
    if (operator === '$lt') return stamp.getTime() < bound.getTime();
    throw new Error(`unhandled comparison operator ${operator}`);
  };

  it.each([
    ['one backoff old exactly', 0, true],
    ['a millisecond older than the backoff', -1, true],
    ['a millisecond short of the backoff', 1, false],
  ])('agrees on a stamp %s', (_label, offsetMs, expected) => {
    const stamp = new Date(NOW - TAG_RETRY_BACKOFF_MS + offsetMs);

    expect(isTagAttemptDue({ tagLastAttemptAt: stamp }, NOW)).toBe(expected);
    expect(filterMatches(stamp, NOW)).toBe(expected);
  });

  it.each([
    ['a missing stamp', undefined],
    ['an explicit null', null],
  ])('treats %s as never attempted', (_label, stamp) => {
    expect(isTagAttemptDue({ tagLastAttemptAt: stamp }, NOW)).toBe(true);
    // The filter's other arm is what covers this in Mongo; `null` matches a missing field too.
    expect(dueArms(NOW)[0]).toEqual({ tagLastAttemptAt: null });
  });

  // Spread beside the top-level `$or` the soft-delete idiom uses, a bare `$or` would clobber it
  // and widen the query to soft-deleted rows. countTaggableNotebooks spreads this helper.
  it('nests its $or so it survives being spread beside another one', () => {
    const merged = { $or: [{ deletedAt: null }], ...tagAttemptDueFilter(NOW) };

    expect(merged.$or).toEqual([{ deletedAt: null }]);
    expect(merged.$and[0].$or).toHaveLength(2);
  });
});
