import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Proves acceptance criterion #1 from the fileName-sort-tiebreaker fix: paging a `fileName`
 * sort to exhaustion over a lake with duplicate names returns exactly `total` distinct ids,
 * with no id dropped or repeated at a page boundary.
 *
 * Fixture: 500 distinct names, the first 300 tripled (900 rows) plus 200 singles = 1100 files,
 * `limit: 25`. Deliberately larger than the plan's originally measured 10-file/6-tied/limit:3
 * shape - that smaller fixture did not reproduce the tie-order instability against the unfixed
 * builder in this environment (mongod 7.0.14 via mongodb-memory-server 11.2.0; verified directly
 * before writing this test). This fixture does, reliably: against the unfixed (opt-in) builder it
 * reproduced 12 duplicate ids across repeated runs every time it was tried; against the fixed
 * (unconditional) builder it reproduced zero duplicates every time. MongoDB's own docs are explicit
 * that result order for tied sort keys under skip/limit is not guaranteed stable across separate
 * query executions - which is exactly why this class of bug is silent and scale-dependent rather
 * than deterministically reproducible at every size.
 *
 * The collection is quiescent for the whole walk (no concurrent writes). That is what makes
 * "exactly `total` distinct ids" a valid assertion here - the fix makes the sort a total order,
 * it does not make skip-pagination snapshot-consistent under concurrent writes.
 */
describe('fabFileRepository.search fileName page walk', () => {
  setupMongoTest();

  const USER_ID = 'page-walk-user';
  const DISTINCT_NAMES = 500;
  const TRIPLED_NAMES = 300;
  const TOTAL_FILES = TRIPLED_NAMES * 3 + (DISTINCT_NAMES - TRIPLED_NAMES);

  beforeEach(async () => {
    const names: string[] = [];
    for (let i = 0; i < DISTINCT_NAMES; i++) {
      const copies = i < TRIPLED_NAMES ? 3 : 1;
      for (let c = 0; c < copies; c++) names.push(`file${String(i).padStart(4, '0')}.txt`);
    }
    // insertMany bypasses addLowercaseField's pre-hook (it registers on save/findOneAndUpdate/
    // updateOne/updateMany only), so `fileNameLower` is null on every row here. Harmless for this
    // walk, which takes the fileName + collation branch and never reads the field - but extend this
    // fixture to the DocumentDB branch and every sort key would be null, one giant tie that passes
    // under the fix while proving nothing. Same gap as collation-compatibility.test.ts:230-233.
    await FabFile.insertMany(
      names.map(fileName => ({ userId: USER_ID, fileName, type: KnowledgeType.FILE, mimeType: 'text/plain' }))
    );
  }, 30000);

  it('returns exactly total distinct ids, none repeated, over a tied fileName sort', async () => {
    const order = { by: 'fileName' as const, direction: 'asc' as const };
    const limit = 25;

    const seenIds = new Set<string>();
    let duplicateCount = 0;
    let total = -1;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await fabFileRepository.search(USER_ID, '', {}, { page, limit }, order);
      total = result.total;

      for (const file of result.data) {
        const id = String(file._id);
        if (seenIds.has(id)) duplicateCount++;
        seenIds.add(id);
      }

      hasMore = result.hasMore;
      page++;
      // Bounds the walk even if a regression made hasMore never settle.
      if (page > 100) break;
    }

    expect(total).toBe(TOTAL_FILES);
    expect(duplicateCount).toBe(0);
    expect(seenIds.size).toBe(total);
    expect(hasMore).toBe(false);
  }, 30000);
});
