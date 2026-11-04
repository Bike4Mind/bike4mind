import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  exists: vi.fn(),
  hardDeleteUser: vi.fn(),
  endRealtimeConnections: vi.fn(),
  sendComplete: vi.fn(),
  order: [] as string[],
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (...a: unknown[]) => ({ lean: () => h.findOne(...a) }),
    exists: (...a: unknown[]) => h.exists(...a),
  },
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  authSessionService: { endRealtimeConnections: h.endRealtimeConnections },
}));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: h.hardDeleteUser }));
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: h.sendComplete }));

import { completeAccountDeletion } from './completeAccountDeletion';

const USER_ID = '665f1c2e8b3a4d0000000001';
const NOW = new Date('2026-11-04T00:00:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const users = { delete: vi.fn(async () => void h.order.push('delete')) };
const complete = () => completeAccountDeletion(USER_ID, { logger: logger as never, now: NOW });

type HardDeleteContext = { assertInTransaction?: () => Promise<void> };

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.findOne.mockResolvedValue({ email: 'leaving@example.com' });
  h.exists.mockResolvedValue({ _id: USER_ID });
  h.sendComplete.mockImplementation(async () => void h.order.push('email'));
  h.hardDeleteUser.mockImplementation(
    async (_id: string, context: HardDeleteContext, commitDelete: (u: typeof users) => Promise<unknown>) => {
      await context.assertInTransaction?.();
      return { result: await commitDelete(users), subscriptionCancellation: null };
    }
  );
});

describe('completeAccountDeletion', () => {
  it('only matches an account whose scheduled deletion is at or before now', async () => {
    await complete();
    expect(h.findOne).toHaveBeenCalledWith({ _id: USER_ID, 'deletion.scheduledFor': { $lte: NOW } }, 'email');
  });

  it('skips a cancelled or not yet due account: no delete, no email', async () => {
    h.findOne.mockResolvedValue(null);

    await expect(complete()).resolves.toEqual({ deleted: false, reason: 'not_due' });
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('skips a user that no longer exists', async () => {
    h.findOne.mockResolvedValue(null);
    h.exists.mockResolvedValue(null);

    await expect(complete()).resolves.toEqual({ deleted: false, reason: 'not_found' });
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('deletes through the shared hard-delete path as the user themself, then emails the pre-read address', async () => {
    await expect(complete()).resolves.toEqual({ deleted: true });

    expect(h.hardDeleteUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ deletedBy: USER_ID, initiatedBy: 'self' }),
      expect.any(Function)
    );
    expect(users.delete).toHaveBeenCalledWith(USER_ID);
    expect(h.endRealtimeConnections).toHaveBeenCalledWith({ userId: USER_ID }, expect.anything());
    expect(h.sendComplete).toHaveBeenCalledWith('leaving@example.com');
    expect(h.order).toEqual(['delete', 'email']);
  });

  it('skips when the deletion is cancelled between the first check and the delete transaction', async () => {
    h.exists.mockResolvedValue(null);

    await expect(complete()).resolves.toEqual({ deleted: false, reason: 'not_due' });
    expect(users.delete).not.toHaveBeenCalled();
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('still reports the deletion when the email fails, and logs the failure', async () => {
    h.sendComplete.mockRejectedValue(new Error('bus down'));

    await expect(complete()).resolves.toEqual({ deleted: true });
    expect(users.delete).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bus down'));
  });

  it('sends nothing for an account without an email address', async () => {
    h.findOne.mockResolvedValue({ email: null });

    await expect(complete()).resolves.toEqual({ deleted: true });
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('propagates a failed delete so the caller can retry', async () => {
    h.hardDeleteUser.mockRejectedValue(new Error('db down'));

    await expect(complete()).rejects.toThrow('db down');
    expect(h.sendComplete).not.toHaveBeenCalled();
  });
});
