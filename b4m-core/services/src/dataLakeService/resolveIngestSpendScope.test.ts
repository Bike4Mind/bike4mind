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

  it('treats a static-registry lake member as lake work with no lake id', async () => {
    // The population the first cut missed: findMemberLakesForFile discards static-registry
    // meta-tags (documentless lakes cannot declare a chunk policy), which read as "not lake work"
    // and routed the largest corpus on the platform around the cap. Rebuild Passages DOES run
    // over these lakes, and their files carry the meta-tag with no batchId.
    const db = deps();
    const scope = await resolveIngestSpendScope(
      { id: 'f1', userId: 'user1', tags: [{ name: 'datalake:opti-knowledge' }] },
      db as never
    );
    // Empty scope, NOT null: the platform-wide throughput and period windows apply, while the
    // run and lake meters are skipped because a documentless lake has nowhere to write them.
    expect(scope).toEqual({});
    expect(scope).not.toBeNull();
  });

  it('matches a static-registry meta-tag case-insensitively', async () => {
    const db = deps();
    const scope = await resolveIngestSpendScope(
      { id: 'f1', userId: 'user1', tags: [{ name: 'DataLake:Opti-Knowledge' }] },
      db as never
    );
    expect(scope).toEqual({});
  });

  it('prefers the DB-backed lake when a file carries both a static and a real lake tag', async () => {
    const db = deps({ byTag: lake('lake1') });
    const scope = await resolveIngestSpendScope(
      { id: 'f1', userId: 'user1', tags: [{ name: 'datalake:lake1' }, { name: 'datalake:opti-knowledge' }] },
      db as never
    );
    // A resolvable lake id is strictly better than none - it adds the run/lake meters on top of
    // the platform windows the static arm would have given.
    expect(scope).toEqual({ dataLakeId: 'lake1' });
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
