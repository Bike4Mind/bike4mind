import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { getCachedData } from './getCachedData';

describe('cacheService - getCachedData', () => {
  let mockAdapters: { db: { caches: { findByKey: Mock; createOrUpdate: Mock } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = { db: { caches: { findByKey: vi.fn(), createOrUpdate: vi.fn() } } };
  });

  it('returns the cached value on a hit without invoking the callback', async () => {
    mockAdapters.db.caches.findByKey.mockResolvedValue({ result: { cached: true } });
    const callback = vi.fn();

    const result = await getCachedData('k', callback, { db: mockAdapters.db, expiry: 1000 });

    expect(result).toEqual({ cached: true });
    expect(callback).not.toHaveBeenCalled();
    expect(mockAdapters.db.caches.createOrUpdate).not.toHaveBeenCalled();
  });

  it('runs the callback on a miss and stores the result with an expiry', async () => {
    mockAdapters.db.caches.findByKey.mockResolvedValue(null);
    const callback = vi.fn().mockResolvedValue({ fresh: true });

    const result = await getCachedData('k', callback, { db: mockAdapters.db, expiry: 1000 });

    expect(result).toEqual({ fresh: true });
    expect(callback).toHaveBeenCalledOnce();
    const stored = mockAdapters.db.caches.createOrUpdate.mock.calls[0][0];
    expect(stored.key).toBe('k');
    expect(stored.result).toEqual({ fresh: true });
    expect(stored.expiresAt).toBeInstanceOf(Date);
  });

  it('bypasses an existing entry when recache is true', async () => {
    mockAdapters.db.caches.findByKey.mockResolvedValue({ result: { cached: true } });
    const callback = vi.fn().mockResolvedValue({ fresh: true });

    const result = await getCachedData('k', callback, { db: mockAdapters.db, expiry: 1000, recache: true });

    expect(result).toEqual({ fresh: true });
    expect(callback).toHaveBeenCalledOnce();
    expect(mockAdapters.db.caches.createOrUpdate).toHaveBeenCalledOnce();
  });
});
