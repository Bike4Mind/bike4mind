import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;
type Lake = { id: string; name: string; status?: string };

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
// The real recompute owns the transition; this asserts the migration routes candidates into it
// rather than re-deriving "has files" and the status write for itself.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { recomputeLakeStats: (lake: Lake, adapters: unknown) => mockRecompute(lake, adapters) },
}));

import migration from './20260805000001_activate-draft-datalakes-with-files';

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockRecompute.mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 });
});

describe('activate-draft-datalakes-with-files', () => {
  it('selects draft lakes AND lakes stored before the status field existed', async () => {
    mockFind.mockReturnValue(findReturning([]));

    await migration.up();

    expect(mockFind).toHaveBeenCalledWith({ status: { $in: ['draft', null] } });
  });

  it('recomputes every candidate and reports the ones that gained a status', async () => {
    mockFind.mockReturnValue(
      findReturning([
        { id: 'l1', name: 'Filled', status: 'draft' },
        { id: 'l2', name: 'Empty', status: 'draft' },
      ])
    );
    mockRecompute
      .mockResolvedValueOnce({ fileCount: 3, totalSizeBytes: 30 })
      .mockResolvedValueOnce({ fileCount: 0, totalSizeBytes: 0 });

    await migration.up();

    expect(mockRecompute).toHaveBeenCalledTimes(2);
    expect(logged.join('\n')).toContain('activated "Filled" (3 file(s))');
    expect(logged.join('\n')).toContain('activated 1 lake(s); 1 still empty, 0 failed, 2 scanned');
  });

  it('hands recomputeLakeStats the whole lake document, not a narrowed shape', async () => {
    // A partial shape silently counts the meta-tag membership arm alone, so the migration would
    // undercount and leave prefix-only lakes draft.
    const lake = { id: 'l1', name: 'Filled', status: 'draft', datalakeTag: 'datalake:l1', fileTagPrefix: 'l1:' };
    mockFind.mockReturnValue(findReturning([lake]));
    mockRecompute.mockResolvedValue({ fileCount: 1, totalSizeBytes: 10 });

    await migration.up();

    expect(mockRecompute).toHaveBeenCalledWith(lake, expect.anything());
  });

  it('carries on past a lake that fails, and names it', async () => {
    // A migration that threw here would block the whole deploy over a stats-cache rebuild.
    mockFind.mockReturnValue(
      findReturning([
        { id: 'l1', name: 'Broken', status: 'draft' },
        { id: 'l2', name: 'Fine', status: 'draft' },
      ])
    );
    mockRecompute
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValueOnce({ fileCount: 2, totalSizeBytes: 20 });

    await expect(migration.up()).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('activated 1 lake(s); 0 still empty, 1 failed, 2 scanned');
    expect(logged.join('\n')).toContain('"Broken"');
  });

  it('does nothing when no lake is draft', async () => {
    mockFind.mockReturnValue(findReturning([]));

    await migration.up();

    expect(mockRecompute).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('no draft lakes');
  });

  it('is a no-op to roll back', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
