import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

/**
 * logEventSafe is the entry point every post-mutation call site uses: the
 * analytics write is a side effect of an operation that already committed, so a
 * failed write must be recorded and dropped rather than surfaced as a 5xx that
 * invites a retry. logEvent itself keeps throwing - /api/analytics/log-event
 * exists only to perform the write and has to answer with its outcome.
 */

const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const organizationAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./organizationAudit', () => ({ recordOrganizationAuditEventSafe: organizationAudit }));
vi.mock('@bike4mind/services', () => ({ counterService: { incrementUserCounter } }));
vi.mock('@bike4mind/database', () => ({
  mongoose: {},
  Ability: class {},
  User: {},
  UserActivityCounter: {},
  CounterLog: {},
}));

import { OrganizationEvents, UserApiKeyEvents } from '@bike4mind/common';
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

  it('names the caller-supplied context in the failure line without logging the payload', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const logger = { error: vi.fn() };

    await logEventSafe(event, undefined, logger, 'API key key-1');

    const [message] = logger.error.mock.calls[0];
    expect(message).toContain(`${UserApiKeyEvents.REVOKED} for API key key-1;`);
    expect(message).not.toContain(event.metadata.name);
  });

  it('falls back to the global Logger so a failure is never silently dropped', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const loggerError = vi.spyOn(Logger, 'error').mockImplementation(() => {});

    await expect(logEventSafe(event)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining(UserApiKeyEvents.REVOKED), {
      error: expect.any(Error),
    });
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

  it('keeps the trusted actor separate from the analytics subject and stores only the member ID', async () => {
    const metadata = {
      organizationId: 'org',
      userId: 'new-member',
      memberEmail: 'member@example.test',
      memberLevel: 'member',
    };
    await logEvent(
      { userId: 'impersonated-member', type: OrganizationEvents.ADD_ORG_MEMBER, metadata },
      { organizationAuditActorUserId: 'real-admin' }
    );
    expect(organizationAudit).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org',
      actorUserId: 'real-admin',
      action: 'member.added',
      targetId: 'new-member',
    });
    expect(incrementUserCounter).toHaveBeenCalledWith(
      'impersonated-member',
      expect.objectContaining({ metadata }),
      expect.anything()
    );
  });

  it('leaves logEvent throwing, for callers whose response IS the write', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    await expect(logEvent(event)).rejects.toThrow(/counter write failed/);
  });
});
