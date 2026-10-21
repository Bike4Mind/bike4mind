import { describe, it, expect } from 'vitest';
import { mergeNotifyResults, toHandlerResult } from './notifyResultUtils';

describe('mergeNotifyResults', () => {
  it('returns empty result when called with no arguments', () => {
    expect(mergeNotifyResults()).toEqual({
      notifiedUserIds: [],
      failedNotifications: [],
    });
  });

  it('concatenates notifiedUserIds and failedNotifications across results', () => {
    const merged = mergeNotifyResults(
      { notifiedUserIds: ['a'], failedNotifications: [] },
      { notifiedUserIds: ['b'], failedNotifications: [{ userId: 'c', error: 'boom' }] }
    );
    expect(merged.notifiedUserIds).toEqual(['a', 'b']);
    expect(merged.failedNotifications).toEqual([{ userId: 'c', error: 'boom' }]);
  });

  it('joins dispatchErrors with semicolon (preserves all signals)', () => {
    const merged = mergeNotifyResults(
      { notifiedUserIds: [], failedNotifications: [], dispatchError: 'one' },
      { notifiedUserIds: [], failedNotifications: [], dispatchError: 'two' }
    );
    expect(merged.dispatchError).toBe('one; two');
  });
});

describe('toHandlerResult', () => {
  it('omits failedNotifications when none present (preserves Skipped semantics)', () => {
    expect(toHandlerResult({ notifiedUserIds: ['a'], failedNotifications: [] })).toEqual({
      notifiedUserIds: ['a'],
    });
  });

  it('includes failedNotifications when present', () => {
    expect(
      toHandlerResult({
        notifiedUserIds: [],
        failedNotifications: [{ userId: 'u1', error: 'rate_limited' }],
      })
    ).toEqual({
      notifiedUserIds: [],
      failedNotifications: [{ userId: 'u1', error: 'rate_limited' }],
    });
  });

  it('includes notificationDispatchError when present', () => {
    expect(
      toHandlerResult({
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: 'no bot token',
      })
    ).toEqual({
      notifiedUserIds: [],
      notificationDispatchError: 'no bot token',
    });
  });
});
