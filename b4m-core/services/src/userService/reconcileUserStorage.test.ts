import { describe, it, expect, vi } from 'vitest';
import { reconcileUserStorage } from './reconcileUserStorage';

const adapters = (counter: number | null, truth: number, casResult = true) => ({
  db: {
    users: {
      findCurrentStorageSize: vi.fn().mockResolvedValue(counter),
      setCurrentStorageIfUnchanged: vi.fn().mockResolvedValue(casResult),
    },
    fabFiles: { sumFileSizeByUserId: vi.fn().mockResolvedValue(truth) },
  },
});

describe('reconcileUserStorage', () => {
  it('reports drift without writing on a dry run', async () => {
    const deps = adapters(1000, 300);
    const result = await reconcileUserStorage({ userId: 'u1', repair: false }, deps);
    expect(result).toEqual({ userId: 'u1', counter: 1000, truth: 300, drift: 700, repaired: false, conflict: false });
    expect(deps.db.users.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
  });

  it('reads the counter before computing truth', async () => {
    const deps = adapters(1000, 300);
    await reconcileUserStorage({ userId: 'u1', repair: false }, deps);
    expect(deps.db.users.findCurrentStorageSize.mock.invocationCallOrder[0]).toBeLessThan(
      deps.db.fabFiles.sumFileSizeByUserId.mock.invocationCallOrder[0]
    );
  });

  it('reports negative drift when the counter is below truth', async () => {
    const result = await reconcileUserStorage({ userId: 'u1', repair: false }, adapters(100, 300));
    expect(result?.drift).toBe(-200);
  });

  it('returns null for a missing user', async () => {
    const deps = adapters(null, 0);
    expect(await reconcileUserStorage({ userId: 'gone', repair: true }, deps)).toBeNull();
    expect(deps.db.fabFiles.sumFileSizeByUserId).not.toHaveBeenCalled();
  });

  it('repairs by compare-and-set on the counter it read', async () => {
    const deps = adapters(1000, 300);
    const result = await reconcileUserStorage({ userId: 'u1', repair: true }, deps);
    expect(deps.db.users.setCurrentStorageIfUnchanged).toHaveBeenCalledWith('u1', 1000, 300);
    expect(result).toMatchObject({ repaired: true, conflict: false });
  });

  it('asks a repair predicate with the check and honours its answer', async () => {
    const deps = adapters(1000, 300);
    const predicate = vi.fn().mockReturnValue(false);
    const result = await reconcileUserStorage({ userId: 'u1', repair: predicate }, deps);
    expect(predicate).toHaveBeenCalledWith({ counter: 1000, truth: 300 });
    expect(deps.db.users.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ repaired: false, conflict: false });
  });

  it('flags a conflict when the counter moved', async () => {
    const result = await reconcileUserStorage({ userId: 'u1', repair: true }, adapters(1000, 300, false));
    expect(result).toMatchObject({ repaired: false, conflict: true });
  });

  it('does not write when there is no drift', async () => {
    const deps = adapters(300, 300);
    await reconcileUserStorage({ userId: 'u1', repair: true }, deps);
    expect(deps.db.users.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
  });
});
