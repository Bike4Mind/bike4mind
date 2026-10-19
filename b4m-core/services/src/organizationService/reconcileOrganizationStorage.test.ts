import { describe, it, expect, vi } from 'vitest';
import { reconcileOrganizationStorage } from './reconcileOrganizationStorage';

const adapters = (counter: number | null, truth: number, casResult = true) => ({
  db: {
    organizations: {
      findCurrentStorageSize: vi.fn().mockResolvedValue(counter),
      setCurrentStorageIfUnchanged: vi.fn().mockResolvedValue(casResult),
    },
    fabFiles: { sumFileSizeByOrganizationId: vi.fn().mockResolvedValue(truth) },
  },
});

describe('reconcileOrganizationStorage', () => {
  it('reports drift without writing on a dry run', async () => {
    const deps = adapters(1000, 300);
    const result = await reconcileOrganizationStorage({ organizationId: 'o1', repair: false }, deps);
    expect(result).toEqual({
      organizationId: 'o1',
      counter: 1000,
      truth: 300,
      drift: 700,
      repaired: false,
      conflict: false,
    });
    expect(deps.db.organizations.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
  });

  it('reads the counter and the truth by the organization id', async () => {
    const deps = adapters(1000, 300);
    await reconcileOrganizationStorage({ organizationId: 'o1', repair: false }, deps);
    expect(deps.db.organizations.findCurrentStorageSize).toHaveBeenCalledWith('o1');
    expect(deps.db.fabFiles.sumFileSizeByOrganizationId).toHaveBeenCalledWith('o1');
  });

  it('reads the counter before computing truth', async () => {
    const deps = adapters(1000, 300);
    await reconcileOrganizationStorage({ organizationId: 'o1', repair: false }, deps);
    expect(deps.db.organizations.findCurrentStorageSize.mock.invocationCallOrder[0]).toBeLessThan(
      deps.db.fabFiles.sumFileSizeByOrganizationId.mock.invocationCallOrder[0]
    );
  });

  it('reports negative drift when the counter is below truth', async () => {
    const result = await reconcileOrganizationStorage({ organizationId: 'o1', repair: false }, adapters(100, 300));
    expect(result?.drift).toBe(-200);
  });

  it('returns null for a missing organization', async () => {
    const deps = adapters(null, 0);
    expect(await reconcileOrganizationStorage({ organizationId: 'gone', repair: true }, deps)).toBeNull();
    expect(deps.db.fabFiles.sumFileSizeByOrganizationId).not.toHaveBeenCalled();
  });

  it('repairs by compare-and-set on the counter it read', async () => {
    const deps = adapters(1000, 300);
    const result = await reconcileOrganizationStorage({ organizationId: 'o1', repair: true }, deps);
    expect(deps.db.organizations.setCurrentStorageIfUnchanged).toHaveBeenCalledWith('o1', 1000, 300);
    expect(result).toMatchObject({ repaired: true, conflict: false });
  });

  it('asks a repair predicate with the check and honours its answer', async () => {
    const deps = adapters(1000, 300);
    const predicate = vi.fn().mockReturnValue(false);
    const result = await reconcileOrganizationStorage({ organizationId: 'o1', repair: predicate }, deps);
    expect(predicate).toHaveBeenCalledWith({ counter: 1000, truth: 300 });
    expect(deps.db.organizations.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ repaired: false, conflict: false });
  });

  it('flags a conflict when the counter moved', async () => {
    const result = await reconcileOrganizationStorage(
      { organizationId: 'o1', repair: true },
      adapters(1000, 300, false)
    );
    expect(result).toMatchObject({ repaired: false, conflict: true });
  });

  it('does not write when there is no drift', async () => {
    const deps = adapters(300, 300);
    await reconcileOrganizationStorage({ organizationId: 'o1', repair: true }, deps);
    expect(deps.db.organizations.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
  });
});
