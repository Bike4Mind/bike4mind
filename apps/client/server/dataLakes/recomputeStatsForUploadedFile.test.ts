import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ recomputeStatsForLakeTags: vi.fn() }));
vi.mock('@server/dataLakes/recomputeStatsForLakeTags', () => ({
  recomputeStatsForLakeTags: h.recomputeStatsForLakeTags,
}));

import { recomputeStatsForUploadedFile } from './recomputeStatsForUploadedFile';

const logger = { error: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe('recomputeStatsForUploadedFile', () => {
  it('forwards the file tag names once the upload has landed', async () => {
    await recomputeStatsForUploadedFile({ tags: [{ name: 'datalake:acme' }, { name: 'acme:legal' }] }, { logger });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith(['datalake:acme', 'acme:legal'], { logger });
  });

  it('skips a batch file, which the batch finalizer recomputes once for the whole batch', async () => {
    // Per file would be N identical whole-lake aggregations for an N-file upload.
    await recomputeStatsForUploadedFile({ batchId: 'b1', tags: [{ name: 'datalake:acme' }] }, { logger });

    expect(h.recomputeStatsForLakeTags).not.toHaveBeenCalled();
  });

  it('tolerates a file with no tags at all', async () => {
    await recomputeStatsForUploadedFile({}, { logger });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith([], { logger });
  });
});
