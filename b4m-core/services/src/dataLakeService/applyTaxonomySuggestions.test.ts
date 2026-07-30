import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeBatchDocument, IDataLakeDocument, TaxonomyTag } from '@bike4mind/common';
import { applyTaxonomySuggestions } from './applyTaxonomySuggestions';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'acme:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const batch = (overrides: Partial<IDataLakeBatchDocument> = {}): IDataLakeBatchDocument =>
  ({
    id: 'b1',
    dataLakeId: 'lake1',
    taxonomyStatus: 'ready',
    taxonomySuggestions: { tags: [], fileAssignments: [] },
    ...overrides,
  }) as IDataLakeBatchDocument;

const tag = (overrides: Partial<TaxonomyTag> & { suffix: string }): TaxonomyTag => ({
  originalName: `acme:${overrides.suffix}`,
  strength: 0.9,
  source: 'ai',
  matchingFolders: [],
  deleted: false,
  ...overrides,
});

const file = (overrides: Record<string, unknown> = {}) => ({
  id: 'f1',
  relativePath: 'legal/vendor.pdf',
  fileName: 'vendor.pdf',
  tags: [{ name: 'acme:legal', strength: 1 }],
  ...overrides,
});

const makeAdapters = (opts?: {
  batchDoc?: IDataLakeBatchDocument | null;
  lakeDoc?: IDataLakeDocument | null;
  files?: ReturnType<typeof file>[];
}) => ({
  db: {
    dataLakes: { findById: vi.fn().mockResolvedValue(opts && 'lakeDoc' in opts ? opts.lakeDoc : lake()) },
    batches: {
      findById: vi.fn().mockResolvedValue(opts && 'batchDoc' in opts ? opts.batchDoc : batch()),
      setTaxonomyStatusIfActive: vi.fn().mockResolvedValue(batch({ taxonomyStatus: 'applying' })),
    },
    fabFiles: {
      findByBatchId: vi.fn().mockResolvedValue(opts?.files ?? [file()]),
      update: vi.fn().mockResolvedValue(null),
    },
  },
});

describe('applyTaxonomySuggestions', () => {
  it('adds only the taxonomy-derived tags on top of the existing folder tag, merged by name', async () => {
    const adapters = makeAdapters({
      files: [file({ tags: [{ name: 'acme:legal', strength: 1 }] })],
    });

    const result = await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })],
      adapters as any
    );

    expect(result).toEqual({ success: true, filesUpdated: 1 });
    const updateCall = adapters.db.fabFiles.update.mock.calls[0][0];
    expect(updateCall.id).toBe('f1');
    const names = updateCall.tags.map((t: { name: string }) => t.name).sort();
    // Folder tag kept (unchanged), category tag added - never duplicated.
    expect(names).toEqual(['acme:legal', 'acme:type:contract']);
  });

  it('skips a file with nothing new to add (no wasted write)', async () => {
    const adapters = makeAdapters({
      files: [file({ relativePath: 'other/vendor.pdf', tags: [{ name: 'acme:other', strength: 1 }] })],
    });

    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })], // doesn't match "other"
      adapters as any
    );

    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it('rejects a non-owner, non-admin caller', async () => {
    const adapters = makeAdapters();

    await expect(
      applyTaxonomySuggestions({ userId: 'stranger', isAdmin: false }, 'b1', [], adapters as any)
    ).rejects.toThrow(/creator/i);
    expect(adapters.db.batches.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });

  it('allows an admin to apply suggestions for a lake they do not own', async () => {
    const adapters = makeAdapters();

    await expect(
      applyTaxonomySuggestions({ userId: 'root', isAdmin: true }, 'b1', [], adapters as any)
    ).resolves.toMatchObject({ success: true });
  });

  it('refuses when the batch is not ready (guarded claim lost)', async () => {
    const adapters = makeAdapters();
    adapters.db.batches.setTaxonomyStatusIfActive = vi.fn().mockResolvedValue(null);

    await expect(
      applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], adapters as any)
    ).rejects.toThrow(/not ready/i);
    expect(adapters.db.fabFiles.findByBatchId).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for a missing batch or lake', async () => {
    const missingBatch = makeAdapters({ batchDoc: null });
    await expect(
      applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], missingBatch as any)
    ).rejects.toThrow(/batch not found/i);

    const missingLake = makeAdapters({ lakeDoc: null });
    await expect(
      applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], missingLake as any)
    ).rejects.toThrow(/data lake not found/i);
  });

  it('marks the batch applied once every file has been processed', async () => {
    const adapters = makeAdapters({ files: [file(), file({ id: 'f2', relativePath: 'legal/2.pdf' })] });

    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })],
      adapters as any
    );

    expect(adapters.db.batches.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(
      1,
      'b1',
      ['ready'],
      'applying',
      expect.objectContaining({ taxonomyStartedAt: expect.any(Date) })
    );
    expect(adapters.db.batches.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(2, 'b1', ['applying'], 'applied');
  });

  it('refreshes taxonomyStartedAt on the claim, so the stuck-job reconciler times out from now', async () => {
    const adapters = makeAdapters();

    await applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], adapters as any);

    expect(adapters.db.batches.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(
      1,
      'b1',
      ['ready'],
      'applying',
      expect.objectContaining({ taxonomyStartedAt: expect.any(Date) })
    );
  });
});
