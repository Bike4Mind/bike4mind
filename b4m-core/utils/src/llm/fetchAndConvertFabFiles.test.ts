import { describe, it, expect, vi } from 'vitest';
import { fetchAndConvertFabFiles } from './utils';

/**
 * `getAccessibleFiles` applies a permission scope and simply omits what it rejects, so a requested
 * id can disappear between the composer and the prompt with nothing anywhere naming it - the turn
 * then runs as though the file had never been attached (#2228). What is locked here is that the
 * caller is told which ids came back short.
 */
describe('fetchAndConvertFabFiles reports ids it could not resolve', () => {
  const logger = { info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const deps = (returned: Array<{ id: string }>) => ({
    db: {
      fabfiles: {
        getAccessibleFiles: vi.fn().mockResolvedValue(returned.map(f => ({ ...f, userId: { toString: () => 'u1' } }))),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unused on this path
      caches: {} as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unused on this path
    storage: {} as any,
    logger: logger as never,
  });

  it('returns the requested ids that were not resolved and names them in a warning', async () => {
    vi.clearAllMocks();

    const { files, missingIds } = await fetchAndConvertFabFiles(
      ['keep-1', 'gone-1', 'gone-2'],
      { scope: {} },
      deps([{ id: 'keep-1' }])
    );

    expect(files.map(f => f.id)).toEqual(['keep-1']);
    expect(missingIds).toEqual(['gone-1', 'gone-2']);
    const warned = logger.warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(warned).toContain('gone-1');
    expect(warned).toContain('gone-2');
  });

  it('reports nothing missing and does not warn when every id resolves', async () => {
    vi.clearAllMocks();

    const { files, missingIds } = await fetchAndConvertFabFiles(
      ['a', 'b'],
      { scope: {} },
      deps([{ id: 'a' }, { id: 'b' }])
    );

    expect(files).toHaveLength(2);
    expect(missingIds).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not report a duplicate requested id as missing', async () => {
    vi.clearAllMocks();

    const { missingIds } = await fetchAndConvertFabFiles(['a', 'a'], { scope: {} }, deps([{ id: 'a' }]));

    expect(missingIds).toEqual([]);
  });

  it('forwards lakeAccess to getAccessibleFiles unchanged, and omits it when absent', async () => {
    vi.clearAllMocks();
    const d = deps([{ id: 'a' }]);
    const lakeAccess = { lakeMemberships: [{ kind: 'owned' as const, datalakeTag: 'datalake:org1:acme' }] };

    await fetchAndConvertFabFiles(['a'], { scope: { userId: 'u1' }, lakeAccess }, d);
    expect(d.db.fabfiles.getAccessibleFiles).toHaveBeenCalledWith(['a'], { userId: 'u1' }, lakeAccess);

    d.db.fabfiles.getAccessibleFiles.mockClear();
    await fetchAndConvertFabFiles(['a'], { scope: { userId: 'u1' } }, d);
    expect(d.db.fabfiles.getAccessibleFiles).toHaveBeenCalledWith(['a'], { userId: 'u1' }, undefined);
  });

  it('still reports missingIds correctly when lakeAccess widens what resolves', async () => {
    vi.clearAllMocks();
    const lakeAccess = { dataLakeTags: ['datalake:org1:acme'] };

    const { files, missingIds } = await fetchAndConvertFabFiles(
      ['keep-1', 'gone-1'],
      { scope: {}, lakeAccess },
      deps([{ id: 'keep-1' }])
    );

    expect(files.map(f => f.id)).toEqual(['keep-1']);
    expect(missingIds).toEqual(['gone-1']);
  });
});
