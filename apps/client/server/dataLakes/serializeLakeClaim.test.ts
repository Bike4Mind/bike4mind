import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  touchIfStable: vi.fn(),
  tx: [] as string[],
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => unknown) => {
    h.tx.push('enter');
    try {
      return await fn();
    } finally {
      h.tx.push('exit');
    }
  },
  dataLakeRepository: { touchIfStable: h.touchIfStable },
}));

import { serializeLakeClaim } from './serializeLakeClaim';

describe('serializeLakeClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tx.length = 0;
    h.touchIfStable.mockImplementation(async () => (h.tx.push('touch'), true));
  });

  it('touches the claimed lake after the claim, inside the transaction, and returns the claim result', async () => {
    const result = await serializeLakeClaim(async () => {
      h.tx.push('claim');
      return { lake: { id: 'lake1' }, extra: 42 } as never;
    });

    expect(h.touchIfStable).toHaveBeenCalledWith('lake1');
    expect(h.tx).toEqual(['enter', 'claim', 'touch', 'exit']);
    expect(result).toMatchObject({ lake: { id: 'lake1' }, extra: 42 });
  });

  it('propagates a failed claim without touching the lake', async () => {
    const boom = new Error('claim lost');

    await expect(
      serializeLakeClaim(async () => {
        throw boom;
      })
    ).rejects.toThrow(boom);
    expect(h.touchIfStable).not.toHaveBeenCalled();
  });

  // A skipped (transitional) lake is not an error; the claim still stands, just unserialized.
  it('still returns the result when the lake is not stable enough to touch', async () => {
    h.touchIfStable.mockResolvedValue(false);

    const result = await serializeLakeClaim(async () => ({ lake: { id: 'lake1' } }) as never);

    expect(result).toEqual({ lake: { id: 'lake1' } });
  });
});
