import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { DataLakeModel, dataLakeRepository, type InconsistencyScanCursor } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * The scan `lakeInconsistencySweep` runs over `status: 'active'` lakes, against real Mongo rather
 * than a mocked `find`, for the reason its health-sweep sibling documents: the behavior under test
 * IS the sort and filter, and the bugs that matter here (a cursor re-matching the run's own writes,
 * a `$gt: null` matching nothing because comparison operators are type-bracketed) are invisible to
 * a stubbed query whose literal shape is all that gets asserted.
 *
 * The two sweeps now SHARE their page predicate and differ only in which stamp field they pass, so
 * what this file is really for is the half that sharing cannot cover: that this scan reads and
 * writes `lastInconsistencyScanAt` and nothing else. A field name copy-pasted from the health
 * sweep would leave both crons contending for one stamp - each one's run marking the other's lakes
 * as done - and every filter-shape assertion in the world would still pass.
 */
describe('DataLakeRepository - inconsistency sweep staleness ordering', () => {
  setupMongoTest();

  const CAP = 3;

  const seedLake = (slug: string): Omit<IDataLake, 'id'> =>
    ({
      name: slug,
      slug,
      fileTagPrefix: `${slug}:`,
      datalakeTag: `datalake:${slug}`,
      createdByUserId: 'inconsistency-sweep-fairness',
      status: 'active',
    }) as Omit<IDataLake, 'id'>;

  /**
   * One simulated sweep run: lakeInconsistencySweep.ts's exact loop - keyset-paged
   * findDueForInconsistencyScan plus the unconditional stamp. `pageSize` defaults to the cap;
   * a smaller one exercises the multi-page keyset, the only way to reach the cursor arms. Returns
   * ids in VISIT order, never deduped, so a lake scanned twice shows up rather than being hidden.
   */
  async function runSweepPass(cap: number, at: Date, pageSize: number = cap): Promise<string[]> {
    const visited: string[] = [];
    let cursor: InconsistencyScanCursor | null = null;
    while (visited.length < cap) {
      const limit = Math.min(pageSize, cap - visited.length);
      const page = await dataLakeRepository.findDueForInconsistencyScan({
        cursor,
        limit,
        excludeScannedAt: at,
        projection: { _id: 1, lastInconsistencyScanAt: 1 },
      });
      if (page.length === 0) break;
      const last = page[page.length - 1];
      cursor = { lastInconsistencyScanAt: last.lastInconsistencyScanAt ?? null, id: last.id };
      for (const lake of page) {
        visited.push(lake.id);
        await dataLakeRepository.markInconsistencyScanned(lake.id, at);
      }
      if (page.length < limit) break;
    }
    return visited;
  }

  const seed = async (slugs: string[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const slug of slugs) ids.push((await dataLakeRepository.create(seedLake(slug))).id);
    return ids;
  };

  it('drains a fleet larger than one run past the cap instead of rescanning the same prefix', async () => {
    // The fairness invariant, and the reason the scan is not paged by `_id`: at 4 lakes and a cap
    // of 3, an `_id`-ordered scan would rescan lakes 1-3 forever and never read lake 4 at all -
    // which for THIS sweep means its corpus is never checked, not merely regraded late.
    const ids = await seed(['lake-a', 'lake-b', 'lake-c', 'lake-d']);

    const first = await runSweepPass(CAP, new Date('2026-03-01T00:00:00Z'));
    const second = await runSweepPass(CAP, new Date('2026-03-02T00:00:00Z'));

    expect(first).toHaveLength(3);
    expect(second).toContain(ids[3]);
    expect(new Set([...first, ...second])).toEqual(new Set(ids));
  });

  it('never scans one lake twice in a single run, even across a page boundary', async () => {
    // The scan sorts on the very field it stamps, so without the `$ne` on the run's own stamp every
    // already-scanned lake re-enters the candidate set behind an older cursor. Here that is a
    // second ~1000-chunk chunk-text pass, not a wasted aggregation.
    await seed(['dup-a', 'dup-b', 'dup-c']);

    const visited = await runSweepPass(CAP, new Date('2026-03-01T00:00:00Z'), 1);

    expect(visited).toHaveLength(new Set(visited).size);
  });

  it('crosses from never-scanned lakes to dated ones within one run', async () => {
    // `$gt: null` matches nothing (type-bracketed comparison), so a cursor landing on a
    // never-scanned lake needs the explicit "leave the null group" arm or the run ends there and
    // every dated lake is skipped.
    const ids = await seed(['null-a', 'dated-b']);
    await dataLakeRepository.markInconsistencyScanned(ids[1], new Date('2026-01-01T00:00:00Z'));

    const visited = await runSweepPass(2, new Date('2026-03-01T00:00:00Z'), 1);

    expect(visited).toEqual([ids[0], ids[1]]);
  });

  it('scans only active lakes', async () => {
    const [activeId] = await seed(['active-one']);
    const draft = await dataLakeRepository.create({ ...seedLake('draft-one'), status: 'draft' } as Omit<
      IDataLake,
      'id'
    >);

    const visited = await runSweepPass(CAP, new Date('2026-03-01T00:00:00Z'));

    expect(visited).toEqual([activeId]);
    expect(visited).not.toContain(draft.id);
  });

  it('keys on lastInconsistencyScanAt alone, leaving the health sweep its own stamp', async () => {
    // Two sweeps, two stamps. Sharing one would have each run marking the other's lakes as done,
    // so a lake would be graded or scanned at half the intended rate with nothing going red.
    const [id] = await seed(['independent-stamps']);
    const healthAt = new Date('2026-02-01T00:00:00Z');
    await dataLakeRepository.markHealthChecked(id, healthAt);

    // A lake the health sweep just graded is still due for a detection scan.
    const beforeScan = await dataLakeRepository.findDueForInconsistencyScan({
      cursor: null,
      limit: 10,
      excludeScannedAt: new Date('2026-03-01T00:00:00Z'),
      projection: { _id: 1, lastInconsistencyScanAt: 1 },
    });
    expect(beforeScan.map(l => l.id)).toEqual([id]);

    const scanAt = new Date('2026-03-01T00:00:00Z');
    await dataLakeRepository.markInconsistencyScanned(id, scanAt);

    const stamps = await DataLakeModel.findById(id, {
      lastHealthCheckedAt: 1,
      lastInconsistencyScanAt: 1,
    }).lean();
    expect(stamps?.lastHealthCheckedAt).toEqual(healthAt);
    expect(stamps?.lastInconsistencyScanAt).toEqual(scanAt);

    // And the health sweep still sees its own stamp untouched by the detection scan.
    const healthDue = await dataLakeRepository.hasMoreDueForHealthCheck(null, healthAt);
    expect(healthDue).toBe(false);
  });

  it('reports a remainder behind the cursor, and none once the fleet is drained', async () => {
    const ids = await seed(['more-a', 'more-b']);
    const at = new Date('2026-03-01T00:00:00Z');

    const cursor: InconsistencyScanCursor = { lastInconsistencyScanAt: null, id: ids[0] };
    expect(await dataLakeRepository.hasMoreDueForInconsistencyScan(cursor, at)).toBe(true);

    for (const id of ids) await dataLakeRepository.markInconsistencyScanned(id, at);
    expect(await dataLakeRepository.hasMoreDueForInconsistencyScan(null, at)).toBe(false);
  });
});
