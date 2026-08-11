import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;
type Lake = { id: string; name: string; fileCount?: number; totalSizeBytes?: number };

const mockFind = vi.fn<(filter: Filter) => { cursor: () => Lake[] }>();
const mockRecompute =
  vi.fn<(lake: Lake, adapters: unknown) => Promise<{ fileCount: number; totalSizeBytes: number }>>();

// Mirrors the real Query: `.find()` returns synchronously and `.cursor()` on it does too - the
// async part is iteration, which a plain array satisfies fine under `for await`.
const findReturning = (lakes: Lake[]) => ({ cursor: () => lakes });

vi.mock('@bike4mind/database', () => ({
  DataLakeModel: { find: (filter: Filter) => mockFind(filter) },
  dataLakeRepository: {},
  fabFileRepository: {},
}));
// The real recompute owns the aggregate + write; this asserts the migration routes every lake
// into it rather than re-deriving "is this stale" for itself.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { recomputeLakeStats: (lake: Lake, adapters: unknown) => mockRecompute(lake, adapters) },
}));

import migration from './20260811000000_recompute-stale-datalake-stats';

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

describe('recompute-stale-datalake-stats', () => {
  it('scans every lake, with no status filter', async () => {
    mockFind.mockReturnValue(findReturning([]));

    await migration.up();

    expect(mockFind).toHaveBeenCalledWith({});
  });

  it('reports a lake whose recomputed stats differ from the stored ones', async () => {
    mockFind.mockReturnValue(findReturning([{ id: 'l1', name: 'Stale', fileCount: 5, totalSizeBytes: 500 }]));
    mockRecompute.mockResolvedValue({ fileCount: 4, totalSizeBytes: 400 });

    await migration.up();

    expect(logged.join('\n')).toContain('corrected "Stale": fileCount 5 -> 4, totalSizeBytes 500 -> 400');
    expect(logged.join('\n')).toContain('corrected 1 lake(s); 0 failed, 1 scanned');
  });

  it('does not report a lake whose recomputed stats already match', async () => {
    mockFind.mockReturnValue(findReturning([{ id: 'l1', name: 'Fine', fileCount: 3, totalSizeBytes: 30 }]));
    mockRecompute.mockResolvedValue({ fileCount: 3, totalSizeBytes: 30 });

    await migration.up();

    expect(logged.join('\n')).not.toContain('corrected "Fine"');
    expect(logged.join('\n')).toContain('corrected 0 lake(s); 0 failed, 1 scanned');
  });

  it('treats a missing stored fileCount/totalSizeBytes as 0, not as already matching', async () => {
    mockFind.mockReturnValue(findReturning([{ id: 'l1', name: 'NeverStamped' }]));
    mockRecompute.mockResolvedValue({ fileCount: 2, totalSizeBytes: 20 });

    await migration.up();

    expect(logged.join('\n')).toContain('corrected "NeverStamped": fileCount 0 -> 2, totalSizeBytes 0 -> 20');
  });

  it('hands recomputeLakeStats the whole lake document, not a narrowed shape', async () => {
    // A partial shape silently counts the meta-tag membership arm alone, undercounting a
    // prefix-arm-only lake.
    const lake = { id: 'l1', name: 'Filled', datalakeTag: 'datalake:l1', fileTagPrefix: 'l1:' };
    mockFind.mockReturnValue(findReturning([lake]));
    mockRecompute.mockResolvedValue({ fileCount: 1, totalSizeBytes: 10 });

    await migration.up();

    expect(mockRecompute).toHaveBeenCalledWith(lake, expect.anything());
  });

  it('carries on past a lake that fails, and names it', async () => {
    // A migration that threw here would block the whole deploy over a stats-cache rebuild.
    mockFind.mockReturnValue(
      findReturning([
        { id: 'l1', name: 'Broken', fileCount: 0, totalSizeBytes: 0 },
        { id: 'l2', name: 'Fine', fileCount: 2, totalSizeBytes: 20 },
      ])
    );
    mockRecompute.mockRejectedValueOnce(new Error('mongo down')).mockResolvedValueOnce({
      fileCount: 2,
      totalSizeBytes: 20,
    });

    await expect(migration.up()).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('corrected 0 lake(s); 1 failed, 2 scanned');
    expect(logged.join('\n')).toContain('"Broken"');
  });

  it('does nothing when there are no lakes', async () => {
    mockFind.mockReturnValue(findReturning([]));

    await migration.up();

    expect(mockRecompute).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('no lakes, nothing to do');
  });

  it('is a no-op to roll back', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
