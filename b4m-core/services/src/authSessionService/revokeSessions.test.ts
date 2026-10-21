import { describe, it, expect, vi } from 'vitest';
import { revokeSession, revokeAllUserSessions } from './revokeSessions';
import { endRealtimeConnections } from './endRealtimeConnections';
import { createMockAuthSessionRepository, createMockRealtimeConnectionRepository } from '../__tests__/utils/testUtils';

const makeDb = () => ({
  authSessions: createMockAuthSessionRepository(),
  realtimeConnections: createMockRealtimeConnectionRepository(),
});

describe('revokeSession', () => {
  it("revokes the session and ends that session's realtime connections", async () => {
    const db = makeDb();
    db.authSessions.revokeBySid.mockResolvedValue({ sid: 'sid-1' } as never);
    await revokeSession('sid-1', { db });
    expect(db.authSessions.revokeBySid).toHaveBeenCalledWith('sid-1');
    expect(db.realtimeConnections.endConnections).toHaveBeenCalledWith({ sid: 'sid-1' });
  });

  it('still ends the connections when the session was already revoked', async () => {
    const db = makeDb();
    db.authSessions.revokeBySid.mockResolvedValue(null);
    await revokeSession('sid-1', { db });
    expect(db.realtimeConnections.endConnections).toHaveBeenCalledWith({ sid: 'sid-1' });
  });
});

describe('revokeAllUserSessions', () => {
  it("ends all of the user's session connections", async () => {
    const db = makeDb();
    db.authSessions.revokeAllByUserId.mockResolvedValue(2);
    await expect(revokeAllUserSessions('user-1', {}, { db })).resolves.toBe(2);
    expect(db.realtimeConnections.endConnections).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionsOnly: true,
    });
  });

  it("keeps the excepted session's connections", async () => {
    const db = makeDb();
    db.authSessions.revokeAllByUserId.mockResolvedValue(1);
    await revokeAllUserSessions('user-1', { exceptSid: 'keep' }, { db });
    expect(db.authSessions.revokeAllByUserId).toHaveBeenCalledWith('user-1', { exceptSid: 'keep' });
    expect(db.realtimeConnections.endConnections).toHaveBeenCalledWith({
      userId: 'user-1',
      exceptSid: 'keep',
      sessionsOnly: true,
    });
  });
});

describe('a failing realtime prune', () => {
  it('does not change the outcome of revokeSession', async () => {
    const db = makeDb();
    const revoked = { sid: 'sid-1' } as never;
    db.authSessions.revokeBySid.mockResolvedValue(revoked);
    db.realtimeConnections.endConnections.mockRejectedValue(new Error('db down'));
    const logger = { log: vi.fn(), warn: vi.fn() } as never;

    await expect(revokeSession('sid-1', { db, logger })).resolves.toBe(revoked);
  });

  it('does not change the outcome of revokeAllUserSessions', async () => {
    const db = makeDb();
    db.authSessions.revokeAllByUserId.mockResolvedValue(3);
    db.realtimeConnections.endConnections.mockRejectedValue(new Error('db down'));

    await expect(revokeAllUserSessions('user-1', {}, { db })).resolves.toBe(3);
  });
});

describe('endRealtimeConnections', () => {
  it('logs and returns no ids when the prune fails, using the supplied logger', async () => {
    const db = makeDb();
    db.realtimeConnections.endConnections.mockRejectedValue(new Error('db down'));
    const logger = { log: vi.fn(), warn: vi.fn() };

    await expect(endRealtimeConnections({ sid: 's' }, { db, logger: logger as never })).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns the ended connection ids', async () => {
    const db = makeDb();
    db.realtimeConnections.endConnections.mockResolvedValue({ connectionIds: ['c1', 'c2'] });
    await expect(endRealtimeConnections({ apiKeyId: 'k1' }, { db })).resolves.toEqual(['c1', 'c2']);
  });
});
