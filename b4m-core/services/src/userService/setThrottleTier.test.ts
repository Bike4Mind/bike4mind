import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { setThrottleTier } from './setThrottleTier';

const findById = vi.fn();
const update = vi.fn();
const adapters = { db: { users: { findById, update } } } as never;
const opts = { reason: 'looks automated', source: 'admin' as const, changedBy: 'admin-1' };

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
});

describe('setThrottleTier', () => {
  it('writes shadow tier for a user without throttle', async () => {
    findById.mockResolvedValue({ id: 'u1' });
    const res = await setThrottleTier('u1', 'shadow', opts, adapters);
    expect(res).toEqual({ changed: true, before: 'none', after: 'shadow' });
    expect(update).toHaveBeenCalledWith({
      id: 'u1',
      throttle: {
        tier: 'shadow',
        reason: 'looks automated',
        source: 'admin',
        changedAt: expect.any(Date),
        changedBy: 'admin-1',
      },
    });
  });

  it('does not write when the tier is unchanged', async () => {
    findById.mockResolvedValue({ id: 'u1', throttle: { tier: 'shadow' } });
    const res = await setThrottleTier('u1', 'shadow', opts, adapters);
    expect(res).toEqual({ changed: false, before: 'shadow', after: 'shadow' });
    expect(update).not.toHaveBeenCalled();
  });

  it('treats absent throttle as none when clearing', async () => {
    findById.mockResolvedValue({ id: 'u1' });
    const res = await setThrottleTier('u1', 'none', opts, adapters);
    expect(res.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes tier none when clearing shadow', async () => {
    findById.mockResolvedValue({ id: 'u1', throttle: { tier: 'shadow' } });
    const res = await setThrottleTier('u1', 'none', opts, adapters);
    expect(res).toEqual({ changed: true, before: 'shadow', after: 'none' });
    expect(update.mock.calls[0][0].throttle.tier).toBe('none');
  });

  it('rejects an empty reason', async () => {
    findById.mockResolvedValue({ id: 'u1' });
    await expect(setThrottleTier('u1', 'shadow', { ...opts, reason: '  ' }, adapters)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for an unknown user', async () => {
    findById.mockResolvedValue(null);
    await expect(setThrottleTier('nope', 'shadow', opts, adapters)).rejects.toBeInstanceOf(NotFoundError);
  });
});
