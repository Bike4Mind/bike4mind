import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * logEventSafe is the entry point every post-mutation call site uses: the
 * analytics write is a side effect of an operation that already committed, so a
 * failed write must be recorded and dropped rather than surfaced as a 5xx that
 * invites a retry. logEvent itself keeps throwing - /api/analytics/log-event
 * exists only to perform the write and has to answer with its outcome.
 */

const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({ counterService: { incrementUserCounter } }));
vi.mock('@bike4mind/database', () => ({
  mongoose: {},
  Ability: class {},
  User: {},
  UserActivityCounter: {},
  CounterLog: {},
}));

import { UserApiKeyEvents } from '@bike4mind/common';
import { logEvent, logEventSafe } from './analyticsLog';

const event = {
  userId: 'u1',
  type: UserApiKeyEvents.REVOKED,
  metadata: { keyId: 'key-1', name: 'CLI key' },
} as const;

describe('logEventSafe', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('resolves and reports through the request logger when the write throws', async () => {
    const boom = new Error('counter write failed');
    incrementUserCounter.mockRejectedValueOnce(boom);
    const logger = { error: vi.fn() };

    await expect(logEventSafe(event, { ability: undefined }, logger)).resolves.toBeUndefined();

    // The event type has to reach the log line: it is the only thing that says
    // which analytics write was dropped.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(UserApiKeyEvents.REVOKED), boom);
  });

  it('falls back to console.error so a failure is never silently dropped', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(logEventSafe(event)).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(UserApiKeyEvents.REVOKED), expect.any(Error));
  });

  it('forwards the event and options to logEvent on the success path', async () => {
    const logger = { error: vi.fn() };
    await logEventSafe(event, undefined, logger);

    expect(incrementUserCounter).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ action: UserApiKeyEvents.REVOKED, metadata: event.metadata }),
      expect.anything()
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('leaves logEvent throwing, for callers whose response IS the write', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    await expect(logEvent(event)).rejects.toThrow(/counter write failed/);
  });
});
