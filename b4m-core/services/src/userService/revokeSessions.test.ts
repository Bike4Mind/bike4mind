import { describe, it, expect } from 'vitest';
import { revokeUserSessions, adminRevokeUserSessions } from './revokeSessions';
import { UnauthorizedError, NotFoundError } from '@bike4mind/utils';
import { createMockUserRepository } from '../__tests__/utils/testUtils';

const makeDb = () => {
  const users = createMockUserRepository();
  users.incrementTokenVersion.mockResolvedValue(1);
  return { users };
};

describe('revokeUserSessions', () => {
  it('bumps tokenVersion and returns the new value', async () => {
    const db = makeDb();
    db.users.incrementTokenVersion.mockResolvedValue(4);
    const result = await revokeUserSessions('user-1', { db });
    expect(db.users.incrementTokenVersion).toHaveBeenCalledWith('user-1');
    expect(result).toBe(4);
  });
});

describe('adminRevokeUserSessions', () => {
  it('rejects a non-admin caller and does not bump', async () => {
    const db = makeDb();
    db.users.findById.mockResolvedValue({ id: 'caller', isAdmin: false } as never);
    await expect(adminRevokeUserSessions('caller', { id: 'target' }, { db })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.users.incrementTokenVersion).not.toHaveBeenCalled();
  });

  it('throws NotFound when the target does not exist', async () => {
    const db = makeDb();
    db.users.findById.mockImplementation((id: string) =>
      Promise.resolve((id === 'admin' ? { id: 'admin', isAdmin: true } : null) as never)
    );
    await expect(adminRevokeUserSessions('admin', { id: 'ghost' }, { db })).rejects.toBeInstanceOf(NotFoundError);
    expect(db.users.incrementTokenVersion).not.toHaveBeenCalled();
  });

  it('revokes the target for an admin caller', async () => {
    const db = makeDb();
    db.users.incrementTokenVersion.mockResolvedValue(2);
    db.users.findById.mockImplementation((id: string) =>
      Promise.resolve((id === 'admin' ? { id: 'admin', isAdmin: true } : { id: 'target', isAdmin: false }) as never)
    );
    const result = await adminRevokeUserSessions('admin', { id: 'target' }, { db });
    expect(db.users.incrementTokenVersion).toHaveBeenCalledWith('target');
    expect(result).toBe(2);
  });
});
