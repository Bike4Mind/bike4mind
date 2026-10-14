import { describe, it, expect } from 'vitest';
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
      exceptSid: undefined,
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

describe('endRealtimeConnections', () => {
  it('returns the ended connection ids', async () => {
    const db = makeDb();
    db.realtimeConnections.endConnections.mockResolvedValue({ connectionIds: ['c1', 'c2'] });
    await expect(endRealtimeConnections({ apiKeyId: 'k1' }, { db })).resolves.toEqual(['c1', 'c2']);
  });
});
