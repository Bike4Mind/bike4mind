import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeBatchDocument, IDataLakeDocument } from '@bike4mind/common';
import { dismissTaxonomySuggestion } from './dismissTaxonomySuggestion';

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
    ...overrides,
  }) as IDataLakeBatchDocument;

const makeAdapters = (opts?: {
  batchDoc?: IDataLakeBatchDocument | null;
  lakeDoc?: IDataLakeDocument | null;
  setTaxonomyStatusIfActiveResult?: IDataLakeBatchDocument | null;
}) => ({
  db: {
    dataLakes: { findById: vi.fn().mockResolvedValue(opts && 'lakeDoc' in opts ? opts.lakeDoc : lake()) },
    batches: {
      findById: vi.fn().mockResolvedValue(opts && 'batchDoc' in opts ? opts.batchDoc : batch()),
      setTaxonomyStatusIfActive: vi
        .fn()
        .mockResolvedValue(
          opts && 'setTaxonomyStatusIfActiveResult' in opts
            ? opts.setTaxonomyStatusIfActiveResult
            : batch({ taxonomyStatus: 'dismissed' })
        ),
    },
  },
});

describe('dismissTaxonomySuggestion', () => {
  it("dismisses from 'ready'", async () => {
    const adapters = makeAdapters({ batchDoc: batch({ taxonomyStatus: 'ready' }) });

    const result = await dismissTaxonomySuggestion({ userId: 'owner', isAdmin: false }, 'b1', adapters as any);

    expect(result).toEqual({ success: true });
    expect(adapters.db.batches.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['ready', 'failed'], 'dismissed');
  });

  it("dismisses from 'failed' via the same call, not a separate code path", async () => {
    const adapters = makeAdapters({ batchDoc: batch({ taxonomyStatus: 'failed' }) });

    const result = await dismissTaxonomySuggestion({ userId: 'owner', isAdmin: false }, 'b1', adapters as any);

    expect(result).toEqual({ success: true });
    expect(adapters.db.batches.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['ready', 'failed'], 'dismissed');
  });

  it('rejects a non-owner, non-admin caller without attempting the claim', async () => {
    const adapters = makeAdapters();

    await expect(
      dismissTaxonomySuggestion({ userId: 'stranger', isAdmin: false }, 'b1', adapters as any)
    ).rejects.toThrow(/creator/i);
    expect(adapters.db.batches.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });

  it('allows an admin to dismiss for a lake they do not own', async () => {
    const adapters = makeAdapters();

    await expect(dismissTaxonomySuggestion({ userId: 'root', isAdmin: true }, 'b1', adapters as any)).resolves.toEqual({
      success: true,
    });
  });

  it('treats an already-dismissed batch as success instead of erroring (double-click race)', async () => {
    const adapters = makeAdapters({ setTaxonomyStatusIfActiveResult: null });
    adapters.db.batches.findById = vi
      .fn()
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'ready' })) // initial load
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'dismissed' })); // re-check after lost claim

    await expect(
      dismissTaxonomySuggestion({ userId: 'owner', isAdmin: false }, 'b1', adapters as any)
    ).resolves.toEqual({ success: true });
  });

  it('throws when the claim is lost to a genuinely different state, not a dismiss race', async () => {
    const adapters = makeAdapters({ setTaxonomyStatusIfActiveResult: null });
    adapters.db.batches.findById = vi
      .fn()
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'ready' })) // initial load
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'analyzing' })); // a reanalyze raced in first

    await expect(dismissTaxonomySuggestion({ userId: 'owner', isAdmin: false }, 'b1', adapters as any)).rejects.toThrow(
      /dismissible/i
    );
  });

  it('throws NotFoundError for a missing batch or lake', async () => {
    const missingBatch = makeAdapters({ batchDoc: null });
    await expect(
      dismissTaxonomySuggestion({ userId: 'owner', isAdmin: false }, 'b1', missingBatch as any)
    ).rejects.toThrow(/batch not found/i);

    const missingLake = makeAdapters({ lakeDoc: null });
    await expect(
      dismissTaxonomySuggestion({ userId: 'owner', isAdmin: false }, 'b1', missingLake as any)
    ).rejects.toThrow(/data lake not found/i);
  });
});
