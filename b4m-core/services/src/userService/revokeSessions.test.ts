import { describe, it, expect, vi } from 'vitest';
import { revokeUserSessions, adminRevokeUserSessions } from './revokeSessions';
import { UnauthorizedError, NotFoundError } from '@bike4mind/utils';

const makeDb = (over: Record<string, unknown> = {}) => ({
  users: {
    findById: vi.fn(),
    incrementTokenVersion: vi.fn().mockResolvedValue(1),
    ...over,
  } as any,
});

describe('revokeUserSessions', () => {
  it('bumps tokenVersion and returns the new value', async () => {
    const db = makeDb({ incrementTokenVersion: vi.fn().mockResolvedValue(4) });
    const result = await revokeUserSessions('user-1', { db });
    expect(db.users.incrementTokenVersion).toHaveBeenCalledWith('user-1');
    expect(result).toBe(4);
  });
});

describe('adminRevokeUserSessions', () => {
  it('rejects a non-admin caller and does not bump', async () => {
    const db = makeDb();
    db.users.findById.mockResolvedValue({ id: 'caller', isAdmin: false });
    await expect(adminRevokeUserSessions('caller', { id: 'target' }, { db })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.users.incrementTokenVersion).not.toHaveBeenCalled();
  });

  it('throws NotFound when the target does not exist', async () => {
    const db = makeDb();
    db.users.findById.mockImplementation((id: string) =>
      Promise.resolve(id === 'admin' ? { id: 'admin', isAdmin: true } : null)
    );
    await expect(adminRevokeUserSessions('admin', { id: 'ghost' }, { db })).rejects.toBeInstanceOf(NotFoundError);
    expect(db.users.incrementTokenVersion).not.toHaveBeenCalled();
  });

  it('revokes the target for an admin caller', async () => {
    const db = makeDb({ incrementTokenVersion: vi.fn().mockResolvedValue(2) });
    db.users.findById.mockImplementation((id: string) =>
      Promise.resolve(id === 'admin' ? { id: 'admin', isAdmin: true } : { id: 'target', isAdmin: false })
    );
    const result = await adminRevokeUserSessions('admin', { id: 'target' }, { db });
    expect(db.users.incrementTokenVersion).toHaveBeenCalledWith('target');
    expect(result).toBe(2);
  });
});
