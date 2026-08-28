import { describe, expect, it, vi } from 'vitest';
import { resolveIngestSpendScope } from './resolveIngestSpendScope';

const lake = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  datalakeTag: `datalake:${id}`,
  fileTagPrefix: `${id}:`,
  createdByUserId: 'user1',
  ...overrides,
});

const deps = (overrides: { lakes?: unknown[]; byTag?: unknown; batch?: unknown } = {}) => ({
  dataLakeBatches: { findById: vi.fn().mockResolvedValue(overrides.batch ?? null) },
  dataLakes: {
    find: vi.fn().mockResolvedValue(overrides.lakes ?? []),
    findByDatalakeTag: vi.fn().mockResolvedValue(overrides.byTag ?? null),
  },
});

describe('resolveIngestSpendScope', () => {
  it('resolves a lake-batch upload to its run and the batch lake', async () => {
    const db = deps({ batch: { id: 'batch1', dataLakeId: 'lake1' } });
    const scope = await resolveIngestSpendScope({ id: 'f1', userId: 'user1', batchId: 'batch1' }, db as never);
    expect(scope).toEqual({ batchId: 'batch1', dataLakeId: 'lake1' });
    expect(db.dataLakes.find).not.toHaveBeenCalled();
  });

  it('still meters a batch whose lake row is gone, rather than reading it as non-lake work', async () => {
    const db = deps({ batch: null });
    const scope = await resolveIngestSpendScope({ id: 'f1', userId: 'user1', batchId: 'batch1' }, db as never);
    expect(scope).toEqual({ batchId: 'batch1', dataLakeId: undefined });
  });

  it('resolves a tag-joined member with no batchId - the population the gate used to skip', async () => {
    const db = deps({ byTag: lake('lake1') });
    const scope = await resolveIngestSpendScope(
      { id: 'f1', userId: 'user1', tags: [{ name: 'datalake:lake1' }] },
      db as never
    );
    expect(scope).toEqual({ dataLakeId: 'lake1' });
  });

  it('returns null for a personal file, without touching the lakes collection', async () => {
    const db = deps();
    const scope = await resolveIngestSpendScope({ id: 'f1', userId: 'user1', tags: [{ name: 'notes' }] }, db as never);
    expect(scope).toBeNull();
    expect(db.dataLakes.find).not.toHaveBeenCalled();
    expect(db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('picks the lowest lake id for a multi-lake member, so a redelivery meters the same lake', async () => {
    const file = { id: 'f1', userId: 'user1', tags: [{ name: 'lakeB:docs' }] };
    const db = deps({
      lakes: [lake('lakeB', { fileTagPrefix: 'lakeB:' }), lake('lakeA', { fileTagPrefix: 'lakeB:' })],
    });

    const first = await resolveIngestSpendScope(file, db as never);
    const second = await resolveIngestSpendScope(file, db as never);

    expect(first).toEqual({ dataLakeId: 'lakeA' });
    expect(second).toEqual(first);
  });
});
