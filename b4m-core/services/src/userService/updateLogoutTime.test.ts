import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { updateLogoutTime } from './updateLogoutTime';

describe('userService - updateLogoutTime', () => {
  let mockAdapters: { db: { users: { findById: Mock; update: Mock } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = { db: { users: { findById: vi.fn(), update: vi.fn() } } };
  });

  it('stamps logoutTime on the last login record and persists', async () => {
    const user = {
      id: 'user-1',
      username: 'alice',
      loginRecords: [{ loginTime: new Date('2026-01-01') }, { loginTime: new Date('2026-01-02') }],
    };
    mockAdapters.db.users.findById.mockResolvedValue(user);

    await updateLogoutTime('user-1', mockAdapters as any);

    expect(user.loginRecords[user.loginRecords.length - 1].logoutTime).toBeInstanceOf(Date);
    // Targeted $set - only id + loginRecords, not the whole user doc.
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith({ id: user.id, loginRecords: user.loginRecords });
  });

  it('does not overwrite an already-set logoutTime', async () => {
    const existing = new Date('2026-01-03');
    const user = {
      id: 'user-1',
      username: 'alice',
      loginRecords: [{ loginTime: new Date('2026-01-02'), logoutTime: existing }],
    };
    mockAdapters.db.users.findById.mockResolvedValue(user);

    await updateLogoutTime('user-1', mockAdapters as any);

    expect(user.loginRecords[0].logoutTime).toBe(existing);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('is a no-op when the user has no login records', async () => {
    mockAdapters.db.users.findById.mockResolvedValue({ id: 'user-1', loginRecords: [] });

    await updateLogoutTime('user-1', mockAdapters as any);

    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('is a no-op when the user is not found', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);

    await updateLogoutTime('missing', mockAdapters as any);

    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });
});
