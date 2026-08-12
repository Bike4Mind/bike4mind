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

const tag = (overrides: Partial<TaxonomyTag> & { suffix: string }): TaxonomyTag => ({
  originalName: `acme:${overrides.suffix}`,
  strength: 0.9,
  source: 'ai',
  matchingFolders: [],
  deleted: false,
  ...overrides,
});

// Defaults to actually having suggested the tag most tests below submit as acceptedTags -
// applyTaxonomySuggestions cross-checks originalName against this list, so a test exercising
// something else (e.g. "no files failed") doesn't have to separately wire up a matching
// suggestion just to avoid being filtered out.
const batch = (overrides: Partial<IDataLakeBatchDocument> = {}): IDataLakeBatchDocument =>
  ({
    id: 'b1',
    dataLakeId: 'lake1',
    taxonomyStatus: 'ready',
    taxonomySuggestions: {
      tags: [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })],
      fileAssignments: [],
    },
    ...overrides,
  }) as IDataLakeBatchDocument;

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
  bulkUpdateTagsResult?: number;
}) => ({
  db: {
    dataLakes: { findById: vi.fn().mockResolvedValue(opts && 'lakeDoc' in opts ? opts.lakeDoc : lake()) },
    batches: {
      findById: vi.fn().mockResolvedValue(opts && 'batchDoc' in opts ? opts.batchDoc : batch()),
      setTaxonomyStatusIfActive: vi.fn().mockResolvedValue(batch({ taxonomyStatus: 'applying' })),
    },
    fabFiles: {
      findByBatchId: vi.fn().mockResolvedValue(opts?.files ?? [file()]),
      bulkUpdateTags: vi
        .fn()
        .mockImplementation((updates: unknown[]) => Promise.resolve(opts?.bulkUpdateTagsResult ?? updates.length)),
    },
  },
  logger: { warn: vi.fn() },
  metrics: { recordTagsApplySkipped: vi.fn().mockResolvedValue(undefined) },
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
    const updates = adapters.db.fabFiles.bulkUpdateTags.mock.calls[0][0];
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('f1');
    const names = updates[0].tags.map((t: { name: string }) => t.name).sort();
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

    expect(adapters.db.fabFiles.bulkUpdateTags).toHaveBeenCalledWith([]);
  });

  it('rejects a non-owner, non-admin caller', async () => {
    const adapters = makeAdapters();

    await expect(
      applyTaxonomySuggestions({ userId: 'stranger', isAdmin: false }, 'b1', [], adapters as any)
    ).rejects.toThrow(/creator/i);
    expect(adapters.db.batches.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });

  // A prefix colliding with a static-registry lake (opti:) has no owning document, so its read
  // arm is an ownership bypass - create() already refuses such a prefix, so this only fires for
  // a row that predates that check.
  it('refuses to apply tags for a lake whose prefix overlaps a static-registry lake', async () => {
    const adapters = makeAdapters({ lakeDoc: lake({ fileTagPrefix: 'opti:' }) });

    await expect(
      applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], adapters as any)
    ).rejects.toThrow(/overlaps a built-in data lake/i);
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

  it('reverts the claim to ready and rethrows when the bulk write fails, instead of stranding the batch in applying', async () => {
    const adapters = makeAdapters();
    const writeError = new Error('bulkWrite failed');
    adapters.db.fabFiles.bulkUpdateTags = vi.fn().mockRejectedValue(writeError);

    await expect(
      applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], adapters as any)
    ).rejects.toThrow(writeError);

    expect(adapters.db.batches.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(2, 'b1', ['applying'], 'ready');
  });

  // The review panel only ever edits a suggested tag's suffix, never fabricates a new
  // originalName - so an accepted tag whose originalName the batch never actually suggested
  // must not be trusted, regardless of what the request schema allowed through.
  it('drops an accepted tag whose originalName was never actually suggested for this batch', async () => {
    const adapters = makeAdapters({
      files: [file({ tags: [] })],
    });

    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'made:up', originalName: 'acme:made:up', matchingFolders: ['legal'] })],
      adapters as any
    );

    expect(adapters.db.fabFiles.bulkUpdateTags).toHaveBeenCalledWith([]);
  });

  it("passes each file's pre-merge tags snapshot as expectedTags, for bulkUpdateTags' optimistic concurrency check", async () => {
    const existingTags = [{ name: 'acme:legal', strength: 1 }];
    const adapters = makeAdapters({
      files: [file({ tags: existingTags })],
    });

    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })],
      adapters as any
    );

    const updates = adapters.db.fabFiles.bulkUpdateTags.mock.calls[0][0];
    expect(updates[0].expectedTags).toEqual(existingTags);
  });

  it('warns with the skip count when bulkUpdateTags reports fewer modified than matched (a race lost)', async () => {
    const adapters = makeAdapters({
      files: [file(), file({ id: 'f2', relativePath: 'legal/2.pdf' })],
      bulkUpdateTagsResult: 1, // 2 files matched, only 1 actually written - 1 lost a concurrency race
    });

    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })],
      adapters as any
    );

    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('1/2'));
    expect(adapters.metrics.recordTagsApplySkipped).toHaveBeenCalledWith(1);
  });

  it('does not warn or record a metric when every matched file was actually updated', async () => {
    const adapters = makeAdapters({
      files: [file({ tags: [{ name: 'acme:legal', strength: 1 }] })],
    });

    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })],
      adapters as any
    );

    expect(adapters.logger.warn).not.toHaveBeenCalled();
    expect(adapters.metrics.recordTagsApplySkipped).not.toHaveBeenCalled();
  });

  it('keeps a genuinely suggested tag even after its suffix was edited by the reviewer', async () => {
    const adapters = makeAdapters({
      files: [file({ tags: [] })],
    });

    // Same originalName as the default suggestion (the stable join key), edited suffix.
    await applyTaxonomySuggestions(
      { userId: 'owner', isAdmin: false },
      'b1',
      [tag({ suffix: 'contract:legal', originalName: 'acme:type:contract', matchingFolders: ['legal'] })],
      adapters as any
    );

    const updates = adapters.db.fabFiles.bulkUpdateTags.mock.calls[0][0];
    expect(updates[0].tags.map((t: { name: string }) => t.name)).toContain('acme:contract:legal');
  });

  it('throws instead of silently reporting success when the final applying -> applied transition loses the race', async () => {
    const adapters = makeAdapters();
    adapters.db.batches.setTaxonomyStatusIfActive = vi
      .fn()
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'applying' })) // claim wins
      .mockResolvedValueOnce(null) // final transition loses (e.g. reconciler force-failed it first)
      .mockResolvedValue(null); // the resulting error path's best-effort revert-to-ready call

    await expect(
      applyTaxonomySuggestions({ userId: 'owner', isAdmin: false }, 'b1', [], adapters as any)
    ).rejects.toThrow(/changed unexpectedly/i);
  });
});
