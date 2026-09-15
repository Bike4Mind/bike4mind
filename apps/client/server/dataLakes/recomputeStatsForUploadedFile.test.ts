import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { dataLakeService } from '@bike4mind/services';

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

  it('forwards the acting principal so a draft -> active flip names the uploader, not `system`', async () => {
    // toEqual ignores undefined-valued keys, so the tag-name assertions above pass with no actor.
    const actor: dataLakeService.ManageActor = {
      userId: 'u1',
      isAdmin: false,
      auditPrincipal: { principalKind: 'apiKey', principalId: 'k1', onBehalfOfUserId: 'u1' },
    };

    await recomputeStatsForUploadedFile({ tags: [{ name: 'datalake:acme' }] }, { logger, actor });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith(['datalake:acme'], { logger, actor });
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
