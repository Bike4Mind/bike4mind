import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'aws-lambda';
import type { ISuspiciousPattern } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  getPatterns: vi.fn(),
  findAll: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: { getSuspiciousPatternsForAlerts: mocks.getPatterns },
  connectDB: vi.fn(),
  userRepository: { findAllByEmailsOrUsernames: mocks.findAll },
}));
vi.mock('@bike4mind/server-utils/utils/logger', () => ({ contextToLogs: vi.fn(() => ({})) }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mocks.publish } } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' }, MONGODB_URI: { value: 'mongodb://%STAGE%' } } }));

const { formatSecurityAlert, handler } = await import('./alertProcessor');

const pattern: ISuspiciousPattern = {
  _id: { ip: '10.0.0.1', timeBucket: new Date() },
  ip: '<i>10.0.0.1</i>',
  attempts: 6,
  usernames: ['someone'],
  strategies: ['local', '<s>other</s>'],
  reasons: [],
  firstAttempt: new Date(),
  lastAttempt: new Date(),
  riskLevel: 'high',
};

describe('formatSecurityAlert', () => {
  it('escapes the username, IP and strategy names in the body', () => {
    const html = formatSecurityAlert(pattern, '<b>x</b>', 'x@example.com');

    expect(html).toContain('Dear &lt;b&gt;x&lt;/b&gt;,');
    expect(html).toContain('&lt;i&gt;10.0.0.1&lt;/i&gt;');
    expect(html).toContain('local, &lt;s&gt;other&lt;/s&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('handler logging', () => {
  const email = 'victim.person@example.com';
  const username = 'victim_person';
  const event = { id: 'evt-1', detail: { secretField: 'do-not-log-this-payload' } };
  const calls = {
    info: vi.spyOn(Logger.prototype, 'info'),
    warn: vi.spyOn(Logger.prototype, 'warn'),
    error: vi.spyOn(Logger.prototype, 'error'),
  };
  const logSpy = vi.spyOn(console, 'log');

  beforeEach(() => {
    vi.clearAllMocks();
    for (const spy of Object.values(calls)) spy.mockImplementation(() => undefined);
    logSpy.mockImplementation(() => undefined);
    mocks.getPatterns.mockResolvedValue([pattern]);
    mocks.findAll.mockResolvedValue([{ id: 'user-1', username, email }]);
    mocks.publish.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const spy of Object.values(calls)) spy.mockReset();
    logSpy.mockReset();
  });

  const allLogged = () => [...calls.info.mock.calls, ...calls.warn.mock.calls, ...calls.error.mock.calls];

  const expectIdentityFree = () => {
    for (const [message, metadata] of allLogged()) {
      expect(typeof message).toBe('string');
      expect(metadata).toEqual(expect.any(Object));
      const serialized = JSON.stringify([message, metadata]);
      for (const secret of [email, username, 'do-not-log-this-payload', JSON.stringify(event)]) {
        expect(serialized).not.toContain(secret);
      }
    }
    expect(logSpy).not.toHaveBeenCalled();
  };

  it('logs counts and user ids as metadata, never identities or the event', async () => {
    const result = await handler(event, {} as Context);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(calls.info).toHaveBeenCalledWith('Security alert sent', { userId: 'user-1' });
    expect(calls.info).toHaveBeenCalledWith('Security alert processing completed', { alertsSent: 1 });
    expectIdentityFree();
  });

  it('logs the user id, not the identity, when the alert email fails to publish', async () => {
    mocks.publish.mockRejectedValue(new Error('bus down'));

    await handler(event, {} as Context);

    expect(calls.error).toHaveBeenCalledWith('Failed to send security alert email', {
      userId: 'user-1',
      error: expect.any(Error),
    });
    expectIdentityFree();
  });

  it('logs an invalid-email skip by user id only', async () => {
    mocks.findAll.mockResolvedValue([{ id: 'user-2', username, email: 'not-an-email' }]);

    await handler(event, {} as Context);

    expect(calls.warn).toHaveBeenCalledWith('Skipping user with invalid email', { userId: 'user-2' });
    expectIdentityFree();
  });
});
