import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'aws-lambda';
import type { ISuspiciousPattern } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  getPatterns: vi.fn(),
  findAll: vi.fn(),
  findByEmail: vi.fn(),
  findByUsernameOrEmail: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: { getSuspiciousPatternsForAlerts: mocks.getPatterns },
  connectDB: vi.fn(),
  userRepository: {
    findAllByEmailsOrUsernames: mocks.findAll,
    findByEmail: mocks.findByEmail,
    findByUsernameOrEmail: mocks.findByUsernameOrEmail,
  },
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
    debug: vi.spyOn(Logger.prototype, 'debug'),
    info: vi.spyOn(Logger.prototype, 'info'),
    warn: vi.spyOn(Logger.prototype, 'warn'),
    error: vi.spyOn(Logger.prototype, 'error'),
  };
  const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));

  beforeEach(() => {
    vi.clearAllMocks();
    for (const spy of Object.values(calls)) spy.mockImplementation(() => undefined);
    for (const spy of consoleSpies) spy.mockImplementation(() => undefined);
    mocks.getPatterns.mockResolvedValue([pattern]);
    mocks.findAll.mockResolvedValue([{ id: 'user-1', username, email }]);
    mocks.publish.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const spy of Object.values(calls)) spy.mockReset();
    for (const spy of consoleSpies) spy.mockReset();
  });

  const allLogged = () => Object.values(calls).flatMap(spy => spy.mock.calls);

  const expectIdentityFree = () => {
    expect(allLogged().length).toBeGreaterThan(0);
    for (const [message, metadata] of allLogged()) {
      expect(typeof message).toBe('string');
      expect(metadata === undefined || typeof metadata === 'object').toBe(true);
      const serialized = JSON.stringify([message, metadata]);
      for (const secret of [email, username, 'do-not-log-this-payload', JSON.stringify(event)]) {
        expect(serialized).not.toContain(secret);
      }
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
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

  it('logs the user id only when the bulk lookup misses and an individual lookup finds the user', async () => {
    mocks.findAll.mockResolvedValue([]);
    mocks.findByUsernameOrEmail.mockResolvedValue({ id: 'user-3', username, email });

    await handler(event, {} as Context);

    expect(mocks.findByUsernameOrEmail).toHaveBeenCalledWith('someone', '');
    expect(calls.info).toHaveBeenCalledWith('Found user by individual lookup', { userId: 'user-3' });
    expect(calls.info).toHaveBeenCalledWith('Security alert sent', { userId: 'user-3' });
    expectIdentityFree();
  });

  it('keeps identities out of every level when an individual lookup throws', async () => {
    mocks.findAll.mockResolvedValue([]);
    mocks.findByUsernameOrEmail.mockRejectedValue(new Error('lookup failed'));

    await handler(event, {} as Context);

    expect(calls.warn).toHaveBeenCalledWith('Failed to find user by individual lookup', { error: expect.any(Error) });
    expectIdentityFree();
  });
});
