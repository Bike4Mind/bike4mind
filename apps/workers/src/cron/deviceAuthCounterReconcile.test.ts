import { describe, it, expect, vi, beforeEach } from 'vitest';

const countPendingAndUnexpired = vi.hoisted(() => vi.fn());
const createOrUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  deviceAuthorizationRepository: { countPendingAndUnexpired },
  cacheRepository: { createOrUpdate },
}));

import { handler } from './deviceAuthCounterReconcile';

describe('deviceAuthCounterReconcile handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the true pending count from the DB and writes it to the cache', async () => {
    countPendingAndUnexpired.mockResolvedValue(42);

    await handler();

    expect(countPendingAndUnexpired).toHaveBeenCalledTimes(1);
    expect(createOrUpdate).toHaveBeenCalledTimes(1);
    expect(createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ result: { count: 42 } })
    );
  });

  it('propagates errors from countPendingAndUnexpired without swallowing them', async () => {
    countPendingAndUnexpired.mockRejectedValue(new Error('DB down'));

    await expect(handler()).rejects.toThrow('DB down');
    expect(createOrUpdate).not.toHaveBeenCalled();
  });

  it('propagates errors from createOrUpdate', async () => {
    countPendingAndUnexpired.mockResolvedValue(10);
    createOrUpdate.mockRejectedValue(new Error('Cache write failed'));

    await expect(handler()).rejects.toThrow('Cache write failed');
  });
});
