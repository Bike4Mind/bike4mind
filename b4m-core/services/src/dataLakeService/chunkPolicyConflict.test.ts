import { describe, expect, it, vi } from 'vitest';
import type { FabFileChunkPolicyConflictLake, IDataLakeDocument } from '@bike4mind/common';
import {
  buildLakeRequirements,
  findMemberLakesForFile,
  findViolatedLakeRequirements,
  recomputeFileChunkPolicyConflict,
} from './chunkPolicyConflict';

const MODEL = 'text-embedding-3-small'; // 8192 window, 20% buffer => hard limit 6554

const req = (name: string, effectiveRequiredTarget: number): FabFileChunkPolicyConflictLake => ({
  lakeId: `id-${name}`,
  datalakeTag: `datalake:${name}`,
  name,
  requiredTarget: effectiveRequiredTarget,
  effectiveRequiredTarget,
});

// A minimal lake doc; only the fields the code touches matter.
const lake = (over: Partial<IDataLakeDocument>): IDataLakeDocument =>
  ({
    id: over.id ?? 'lake-1',
    name: over.name ?? 'Lake',
    datalakeTag: over.datalakeTag ?? 'datalake:lake-1',
    fileTagPrefix: over.fileTagPrefix ?? 'lake:',
    createdByUserId: over.createdByUserId ?? 'owner-1',
    requiredPassageTokenTarget: over.requiredPassageTokenTarget,
    ...over,
  }) as IDataLakeDocument;

describe('findViolatedLakeRequirements (pure conflict decision)', () => {
  it('returns [] when there are no requirements', () => {
    expect(findViolatedLakeRequirements(512, [])).toEqual([]);
  });

  it('returns [] when the single requirement matches the effective target', () => {
    expect(findViolatedLakeRequirements(512, [req('a', 512)])).toEqual([]);
  });

  it('returns the requirement when it differs from the effective target', () => {
    const violated = findViolatedLakeRequirements(512, [req('a', 1024)]);
    expect(violated.map(v => v.name)).toEqual(['a']);
  });

  it('returns only the differing requirements when some match and some do not', () => {
    const violated = findViolatedLakeRequirements(512, [req('match', 512), req('coarser', 1024), req('finer', 256)]);
    expect(violated.map(v => v.name).sort()).toEqual(['coarser', 'finer']);
  });

  it('reports the disagreeing lake when a file is in two lakes with divergent requirements', () => {
    // File chunked at 512 satisfies lake A (512) but not lake B (1024): the exact oscillation case
    // decision 7 replaces with a report.
    const violated = findViolatedLakeRequirements(512, [req('A', 512), req('B', 1024)]);
    expect(violated.map(v => v.name)).toEqual(['B']);
  });
});

describe('buildLakeRequirements', () => {
  it('skips lakes with no required target and clamps required targets through the model window', () => {
    const requirements = buildLakeRequirements(
      [
        lake({ id: 'x', name: 'X', requiredPassageTokenTarget: 512 }),
        lake({ id: 'y', name: 'Y' }), // no requirement -> skipped
        lake({ id: 'z', name: 'Z', requiredPassageTokenTarget: 100_000 }), // clamped to hard limit
      ],
      MODEL
    );
    expect(requirements.map(r => r.lakeId)).toEqual(['x', 'z']);
    expect(requirements.find(r => r.lakeId === 'x')?.effectiveRequiredTarget).toBe(512);
    // 100_000 exceeds the buffered window -> clamped to 6554, but raw kept for display.
    const z = requirements.find(r => r.lakeId === 'z');
    expect(z?.requiredTarget).toBe(100_000);
    expect(z?.effectiveRequiredTarget).toBe(6554);
  });
});

describe('findMemberLakesForFile', () => {
  it('runs zero queries for a file with no lake-membership signal', async () => {
    const find = vi.fn();
    const findByDatalakeTag = vi.fn();
    const lakes = await findMemberLakesForFile(
      { id: 'f1', userId: 'owner-1', tags: [{ name: 'plain-tag' }] },
      { find, findByDatalakeTag }
    );
    expect(lakes).toEqual([]);
    expect(find).not.toHaveBeenCalled();
    expect(findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('resolves a meta-tag membership via findByDatalakeTag', async () => {
    const metaLake = lake({ id: 'meta', datalakeTag: 'datalake:sales', requiredPassageTokenTarget: 512 });
    const find = vi.fn().mockResolvedValue([]);
    const findByDatalakeTag = vi.fn().mockResolvedValue(metaLake);
    const lakes = await findMemberLakesForFile(
      { id: 'f1', userId: 'owner-1', tags: [{ name: 'datalake:sales' }] },
      { find, findByDatalakeTag }
    );
    expect(findByDatalakeTag).toHaveBeenCalledWith('datalake:sales');
    expect(lakes.map(l => l.id)).toEqual(['meta']);
  });

  it('resolves an owner-anchored prefix-arm membership and dedupes against the meta arm', async () => {
    const prefixLake = lake({ id: 'prefix', datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:' });
    const find = vi.fn().mockResolvedValue([prefixLake]);
    const findByDatalakeTag = vi.fn().mockResolvedValue(null);
    const lakes = await findMemberLakesForFile(
      { id: 'f1', userId: 'owner-1', tags: [{ name: 'acme:legal' }] },
      { find, findByDatalakeTag }
    );
    expect(find).toHaveBeenCalledWith({ createdByUserId: 'owner-1' });
    expect(lakes.map(l => l.id)).toEqual(['prefix']);
  });

  it('does not double-count a lake reached by both signals', async () => {
    const both = lake({ id: 'both', datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:' });
    const find = vi.fn().mockResolvedValue([both]);
    const findByDatalakeTag = vi.fn().mockResolvedValue(both);
    const lakes = await findMemberLakesForFile(
      { id: 'f1', userId: 'owner-1', tags: [{ name: 'datalake:acme' }, { name: 'acme:legal' }] },
      { find, findByDatalakeTag }
    );
    expect(lakes.map(l => l.id)).toEqual(['both']);
  });
});

describe('recomputeFileChunkPolicyConflict', () => {
  const makeAdapters = (memberLakes: IDataLakeDocument[]) => {
    const setChunkPolicyConflict = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const db = {
      dataLakes: {
        find: vi.fn().mockResolvedValue(memberLakes),
        findByDatalakeTag: vi
          .fn()
          .mockImplementation(async (tag: string) => memberLakes.find(l => l.datalakeTag === tag) ?? null),
      },
      fabFiles: { setChunkPolicyConflict },
    };
    return { setChunkPolicyConflict, logger, db };
  };

  it('records the effective target and no conflict when the file satisfies every lake', async () => {
    const { db, logger, setChunkPolicyConflict } = makeAdapters([
      lake({ id: 'a', datalakeTag: 'datalake:a', requiredPassageTokenTarget: 512 }),
    ]);
    const conflict = await recomputeFileChunkPolicyConflict(
      { id: 'f1', userId: 'owner-1', tags: [{ name: 'datalake:a' }] },
      512,
      { db, embeddingModel: MODEL, logger: logger as never }
    );
    expect(conflict).toBeNull();
    expect(setChunkPolicyConflict).toHaveBeenCalledWith('f1', 512, null);
    expect(logger.log).toHaveBeenCalled(); // satisfied-requirement observability line
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('records a conflict and warns when the file violates a lake requirement', async () => {
    const { db, logger, setChunkPolicyConflict } = makeAdapters([
      lake({ id: 'a', name: 'Lake A', datalakeTag: 'datalake:a', requiredPassageTokenTarget: 1024 }),
    ]);
    const conflict = await recomputeFileChunkPolicyConflict(
      { id: 'f1', userId: 'owner-1', tags: [{ name: 'datalake:a' }] },
      512,
      { db, embeddingModel: MODEL, logger: logger as never }
    );
    expect(conflict).not.toBeNull();
    expect(conflict?.effectiveTarget).toBe(512);
    expect(conflict?.embeddingModel).toBe(MODEL);
    expect(conflict?.lakes.map(l => l.name)).toEqual(['Lake A']);
    expect(setChunkPolicyConflict).toHaveBeenCalledWith('f1', 512, expect.objectContaining({ effectiveTarget: 512 }));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('clears a stale conflict (writes null) when the file now has no lake requirements', async () => {
    const { db, logger, setChunkPolicyConflict } = makeAdapters([]);
    const conflict = await recomputeFileChunkPolicyConflict({ id: 'f1', userId: 'owner-1', tags: [] }, 512, {
      db,
      embeddingModel: MODEL,
      logger: logger as never,
    });
    expect(conflict).toBeNull();
    expect(setChunkPolicyConflict).toHaveBeenCalledWith('f1', 512, null);
  });
});
