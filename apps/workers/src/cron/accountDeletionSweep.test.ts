import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findDeletionDueUserIds: vi.fn(),
  completeAccountDeletion: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  userRepository: { findDeletionDueUserIds: h.findDeletionDueUserIds },
}));
vi.mock('@server/users/completeAccountDeletion', () => ({ completeAccountDeletion: h.completeAccountDeletion }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));

import { handler, runAccountDeletionSweep } from './accountDeletionSweep';

const NOW = new Date('2026-11-04T05:00:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
const sweep = () => runAccountDeletionSweep({ logger: logger as never, now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  h.findDeletionDueUserIds.mockResolvedValue(['u1', 'u2', 'u3']);
  h.completeAccountDeletion.mockResolvedValue({ deleted: true });
});

describe('runAccountDeletionSweep', () => {
  it('lists the due accounts with a batch limit and completes each in order', async () => {
    const result = await sweep();

    expect(h.findDeletionDueUserIds).toHaveBeenCalledWith(NOW, 200);
    expect(h.completeAccountDeletion.mock.calls.map(([id]) => id)).toEqual(['u1', 'u2', 'u3']);
    expect(h.completeAccountDeletion).toHaveBeenCalledWith('u1', { logger, now: NOW });
    expect(result).toEqual({ deleted: 3, not_due: 0, not_found: 0, busy: 0, failed: 0 });
  });

  it('honours a custom batch size', async () => {
    await runAccountDeletionSweep({ logger: logger as never, now: NOW, batchSize: 5 });
    expect(h.findDeletionDueUserIds).toHaveBeenCalledWith(NOW, 5);
  });

  it('counts skipped accounts by reason', async () => {
    h.completeAccountDeletion
      .mockResolvedValueOnce({ deleted: false, reason: 'not_due' })
      .mockResolvedValueOnce({ deleted: false, reason: 'not_found' });

    await expect(sweep()).resolves.toEqual({ deleted: 1, not_due: 1, not_found: 1, busy: 0, failed: 0 });
  });

  it('counts an account held by a live purge or export as busy', async () => {
    h.completeAccountDeletion.mockResolvedValueOnce({ deleted: false, reason: 'busy' });

    await expect(sweep()).resolves.toEqual({ deleted: 2, not_due: 0, not_found: 0, busy: 1, failed: 0 });
  });

  it('keeps going past a failed account and reports it', async () => {
    h.completeAccountDeletion.mockRejectedValueOnce(new Error('db down'));

    const result = await sweep();

    expect(h.completeAccountDeletion).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 2, not_due: 0, not_found: 0, busy: 0, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('u1'), expect.any(Error));
  });
});

describe('handler', () => {
  it('connects to the stage database and returns the counts', async () => {
    await expect(handler()).resolves.toMatchObject({ deleted: 3, failed: 0 });
    expect(h.connectDB).toHaveBeenCalledWith('mongodb://host/test');
  });

  it('throws at the end when any account failed, after attempting every one, so the run is dead-lettered', async () => {
    h.completeAccountDeletion.mockRejectedValueOnce(new Error('db down'));

    await expect(handler()).rejects.toThrow('1 account(s) failed to delete');
    expect(h.completeAccountDeletion).toHaveBeenCalledTimes(3);
  });
});
