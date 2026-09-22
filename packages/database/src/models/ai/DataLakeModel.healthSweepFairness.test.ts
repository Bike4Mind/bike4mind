import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { dataLakeRepository, type HealthCheckScanCursor } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * The scan `lakeHealthSweep` runs over `status: 'active'` lakes, against real Mongo rather than a
 * mocked `find` - the behavior under test IS the sort and filter doing the work, and every bug
 * these guard against (a cursor that re-matches the run's own writes, a `$gt: null` that matches
 * nothing because comparison operators are type-bracketed, an `_id` tiebreak across a page
 * boundary) is invisible to a stubbed query that only has its literal shape asserted.
 *
 * The invariants: a per-run cap paged by `_id` alone would regrade the same prefix every run and
 * never reach the tail, so the scan is ordered by `lastHealthCheckedAt` (oldest/never-checked
 * first) and every lake a run attempts is stamped, which is what makes the cap self-drain.
 */
describe('DataLakeRepository - lake health sweep staleness ordering', () => {
  setupMongoTest();

  const CAP = 3;

  const seedLake = (slug: string): Omit<IDataLake, 'id'> =>
    ({
      name: slug,
      slug,
      fileTagPrefix: `${slug}:`,
      datalakeTag: `datalake:${slug}`,
      createdByUserId: 'sweep-fairness',
      status: 'active',
    }) as Omit<IDataLake, 'id'>;

  /**
   * One simulated sweep run: lakeHealthSweep.ts's exact loop - keyset-paged
   * findDueForHealthCheck plus the unconditional stamp - driven against real Mongo. `pageSize`
   * defaults to the cap (one page); passing a smaller one exercises the multi-page keyset, which
   * is the only way to reach the cursor arms at all. Returns ids in VISIT order, never deduped, so
   * a lake graded twice in one run shows up as a duplicate rather than being hidden.
   */
  async function runSweepPass(cap: number, at: Date, pageSize: number = cap): Promise<string[]> {
    const visited: string[] = [];
    let cursor: HealthCheckScanCursor | null = null;
    while (visited.length < cap) {
      const limit = Math.min(pageSize, cap - visited.length);
      const page = await dataLakeRepository.findDueForHealthCheck({
        cursor,
        limit,
        excludeCheckedAt: at,
        projection: { _id: 1, lastHealthCheckedAt: 1 },
      });
      if (page.length === 0) break;
      const last = page[page.length - 1];
      cursor = { lastHealthCheckedAt: last.lastHealthCheckedAt ?? null, id: last.id };
      for (const lake of page) {
        visited.push(lake.id);
        await dataLakeRepository.markHealthChecked(lake.id, at);
      }
      if (page.length < limit) break;
    }
    return visited;
  }

  async function seedMany(prefix: string, count: number, checkedAt: Date | null): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const lake = await dataLakeRepository.create(seedLake(`${prefix}-${String(i).padStart(2, '0')}`));
      if (checkedAt) await dataLakeRepository.markHealthChecked(lake.id, checkedAt);
      ids.push(lake.id);
    }
    return ids;
  }

  it('covers every active lake across runs instead of regrading a fixed prefix', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const lake = await dataLakeRepository.create(seedLake(`lake-${i}`));
      ids.push(lake.id);
    }

    // 7 lakes, cap 3: the first two runs exhaust the never-checked lakes (3 + 3 = 6), each getting
    // a STRICTLY LATER stamp than the run before. A run only ever re-picks an already-checked lake
    // once every not-yet-checked lake is gone, and even then it picks the OLDEST-stamped ones - so
    // the un-drained bug (same `_id` prefix regraded forever, tail never reached) cannot reproduce:
    // the still-untouched 7th lake is guaranteed to win a slot the moment any run has headroom for
    // it, because null sorts before every real timestamp.
    const round1 = await runSweepPass(CAP, new Date('2024-01-01T00:00:00Z'));
    const round2 = await runSweepPass(CAP, new Date('2024-01-02T00:00:00Z'));
    const round3 = await runSweepPass(CAP, new Date('2024-01-03T00:00:00Z'));

    expect(round1).toHaveLength(3);
    expect(round2).toHaveLength(3);
    expect(round3).toHaveLength(3);

    // The 7th (never-checked-until-now) lake is not in round1 or round2 (both full of other,
    // equally-unchecked lakes ahead of it by `_id`) but MUST appear by round3 - this is the
    // assertion that fails under the old `_id`-only, uncapped-tail behavior, where a 7th lake past
    // a cap of 6 would never be picked by any run.
    const everCovered = new Set([...round1, ...round2, ...round3]);
    expect(everCovered.size).toBe(7);
    expect([...everCovered].sort()).toEqual([...ids].sort());
  });

  it('a lake stamped despite a failed grading still rotates to the back, not stuck at the front', async () => {
    const ok = await dataLakeRepository.create(seedLake('ok-lake'));
    const flaky = await dataLakeRepository.create(seedLake('flaky-lake'));

    // Round 1: both are unchecked (null sorts first), so both come back; grade "flaky" fails but
    // lakeHealthSweep stamps lastHealthCheckedAt regardless (see its try/finally) - simulated here
    // by calling markHealthChecked unconditionally, same as the real handler does.
    const round1 = await runSweepPass(2, new Date('2024-01-01T00:00:00Z'));
    expect(new Set(round1)).toEqual(new Set([ok.id, flaky.id]));

    // Round 2, cap 1: without the unconditional stamp, a lake whose grading keeps failing would
    // still show `lastHealthCheckedAt: null` and sort first forever, starving `ok-lake` behind it
    // every single run. Advance ok-lake's clock further to make its own staleness the tiebreak.
    await dataLakeRepository.markHealthChecked(ok.id, new Date('2024-01-01T00:00:01Z'));
    await dataLakeRepository.markHealthChecked(flaky.id, new Date('2024-01-01T00:00:02Z'));

    const round2 = await runSweepPass(1, new Date('2024-01-02T00:00:00Z'));
    expect(round2).toEqual([ok.id]);
  });
  it('grades each lake at most once per run, even though the run mutates its own sort key', async () => {
    // Every lake shares one earlier stamp, so the whole scan pages through the _id tiebreak arm.
    // A cursor built from that older stamp matches every lake the run has ALREADY stamped (their
    // new stamp is strictly newer), so without excluding this run's own writes each lake is
    // visited a second time: 2x the fleet-wide DB work, and a cap that reaches half the lakes it
    // advertises.
    const ids = await seedMany('s', 15, new Date('2024-01-01T00:00:00Z'));

    const visited = await runSweepPass(1000, new Date('2024-02-01T00:00:00Z'), 10);

    expect(visited).toHaveLength(ids.length);
    expect(new Set(visited).size).toBe(ids.length);
  });

  it('reaches dated lakes even when a full page ends on a never-checked one', async () => {
    // Mongo's comparison operators are type-bracketed, so a `$gt: null` cursor matches NOTHING
    // rather than every dated document. With the null group spanning whole pages, a scan that
    // cannot cross out of it stops the moment the nulls run out and silently skips every dated
    // lake for that run - the day a bulk import lands, that is the whole pre-existing fleet.
    const nulls = await seedMany('n', 25, null);
    const dated = await seedMany('d', 20, new Date('2024-01-01T00:00:00Z'));

    const visited = await runSweepPass(1000, new Date('2024-02-01T00:00:00Z'), 10);

    expect(new Set(visited)).toEqual(new Set([...nulls, ...dated]));
    expect(visited).toHaveLength(nulls.length + dated.length);
  });

  it('never-checked lakes are graded before dated ones', async () => {
    const dated = await seedMany('d', 5, new Date('2024-01-01T00:00:00Z'));
    const nulls = await seedMany('n', 5, null);

    const visited = await runSweepPass(1000, new Date('2024-02-01T00:00:00Z'), 3);

    expect(visited.slice(0, 5).sort()).toEqual([...nulls].sort());
    expect(visited.slice(5).sort()).toEqual([...dated].sort());
  });

  it('reports no remainder once the scan has walked the whole fleet', async () => {
    await seedMany('s', 6, new Date('2024-01-01T00:00:00Z'));
    const at = new Date('2024-02-01T00:00:00Z');

    // A cap equal to the fleet size leaves the cursor past the last lake: the run covered
    // everything, so warning that a staler remainder was deferred would be a false alarm.
    const visited = await runSweepPass(6, at, 3);
    expect(visited).toHaveLength(6);

    const last = await dataLakeRepository.findDueForHealthCheck({
      cursor: null,
      limit: 1,
      excludeCheckedAt: new Date('2024-03-01T00:00:00Z'),
      projection: { _id: 1, lastHealthCheckedAt: 1 },
    });
    expect(await dataLakeRepository.hasMoreDueForHealthCheck(null, at)).toBe(false);
    // Sanity check that the probe is not vacuously false: a LATER run does see the fleet again.
    expect(last).toHaveLength(1);
  });
});
