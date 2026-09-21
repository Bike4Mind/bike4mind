import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * Proves the fairness fix for #3050: `lakeHealthSweep` used to page `status: 'active'` lakes by
 * `_id` with a hard per-run cap and no persisted cursor, so above the cap the same first-N lakes
 * (by `_id`) were regraded every run and the tail was never snapshotted at all. The fix orders the
 * scan by `lastHealthCheckedAt` (oldest/never-checked first) and stamps it on every lake a run
 * attempts, so the cap self-drains. This exercises the exact query/stamp shape `lakeHealthSweep.ts`
 * uses - real Mongo, not mocked, since the behavior under test IS the sort/filter doing the work.
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

  /** One simulated sweep run: the same staleness-ordered, capped query + unconditional stamp
   * lakeHealthSweep.ts performs (collapsed to a single page since the cap in this test is far
   * below PAGE_SIZE - the multi-page keyset mechanics are covered separately, by the mocked unit
   * test in apps/client/server/cron/lakeHealthSweep.test.ts). */
  async function runSweepPass(cap: number, at: Date): Promise<string[]> {
    const lakes = await dataLakeRepository.find(
      { status: 'active' },
      { sort: { lastHealthCheckedAt: 1, _id: 1 }, limit: cap, _id: 1, lastHealthCheckedAt: 1 }
    );
    for (const lake of lakes) {
      await dataLakeRepository.markHealthChecked(lake.id, at);
    }
    return lakes.map(l => l.id);
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
});
