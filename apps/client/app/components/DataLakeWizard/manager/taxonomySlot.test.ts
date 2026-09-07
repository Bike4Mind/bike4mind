import { describe, it, expect } from 'vitest';
import { TAXONOMY_ATTENTION_STATUSES } from '@bike4mind/common';
import type { IDataLakeBatchSummary } from '@bike4mind/common';
import { selectTaxonomyBatchByLakeId } from './taxonomySlot';

/** Only the three fields the selector reads; the summary type is far wider than this. */
const batch = (overrides: Partial<IDataLakeBatchSummary> & { id: string }) =>
  ({ dataLakeId: 'lake-a', ...overrides }) as IDataLakeBatchSummary;

const pick = (batches: IDataLakeBatchSummary[], lakeId = 'lake-a') =>
  selectTaxonomyBatchByLakeId(batches).get(lakeId)?.id;

describe('selectTaxonomyBatchByLakeId', () => {
  it('returns an empty map for an undefined list', () => {
    expect(selectTaxonomyBatchByLakeId(undefined).size).toBe(0);
  });

  // Eligibility, tested through the selector rather than by comparing SLOT_PRIORITY to the
  // server constant: a new attention status that nobody ranks would silently lose its chip.
  it.each(TAXONOMY_ATTENTION_STATUSES)('keeps a %s batch eligible for the slot', status => {
    expect(selectTaxonomyBatchByLakeId([batch({ id: 'b1', taxonomyStatus: status })]).has('lake-a')).toBe(true);
  });

  it.each(['none', 'applied', 'dismissed'] as const)('skips a lake whose only batch is %s', status => {
    expect(selectTaxonomyBatchByLakeId([batch({ id: 'b1', taxonomyStatus: status })]).has('lake-a')).toBe(false);
  });

  it('skips a batch with no taxonomyStatus at all', () => {
    expect(selectTaxonomyBatchByLakeId([batch({ id: 'b1' })]).has('lake-a')).toBe(false);
  });

  // The reported bug: an applied batch still ingesting arrives first from the server's
  // ingest-active finder and used to squat the slot, hiding the review chip entirely.
  it('prefers the ready batch over an applied one that arrived first', () => {
    expect(pick([batch({ id: 'ap1', taxonomyStatus: 'applied' }), batch({ id: 'b1', taxonomyStatus: 'ready' })])).toBe(
      'b1'
    );
  });

  // Every pair, both arrival orders. Each relation is argued in SLOT_PRIORITY's docblock from
  // which consumer gate the status can render, so an unnoticed reshuffle is a real regression -
  // e.g. 'analyzing' above 'failed' deletes the failed-review affordance. The 'w'/'l' ids are
  // load-bearing: the id tie-break sorts ascending and would answer 'l', so a collapsed rank
  // cannot pass by accident.
  it.each([
    ['ready', 'failed'],
    ['ready', 'analyzing'],
    ['ready', 'queued'],
    ['ready', 'applying'],
    ['failed', 'analyzing'],
    ['failed', 'queued'],
    ['failed', 'applying'],
    ['analyzing', 'queued'],
    ['analyzing', 'applying'],
    ['queued', 'applying'],
  ] as const)('prefers %s over %s regardless of arrival order', (winner, loser) => {
    const w = batch({ id: 'w', taxonomyStatus: winner });
    const l = batch({ id: 'l', taxonomyStatus: loser });
    expect(pick([w, l])).toBe('w');
    expect(pick([l, w])).toBe('w');
  });

  // Two ready siblings on one lake is legal; the winner must not depend on arrival order, and
  // must not move when an unrelated ingest write touches the batch.
  it('breaks a rank tie by id ascending, stably across input order', () => {
    const a = batch({ id: 'aaa', taxonomyStatus: 'ready', updatedAt: new Date('2020-01-01') });
    const z = batch({ id: 'zzz', taxonomyStatus: 'ready', updatedAt: new Date('2026-01-01') });
    expect(pick([z, a])).toBe('aaa');
    expect(pick([a, z])).toBe('aaa');
  });

  it('keeps lakes independent', () => {
    const map = selectTaxonomyBatchByLakeId([
      batch({ id: 'a-ready', dataLakeId: 'lake-a', taxonomyStatus: 'ready' }),
      batch({ id: 'b-failed', dataLakeId: 'lake-b', taxonomyStatus: 'failed' }),
    ]);
    expect(map.get('lake-a')?.id).toBe('a-ready');
    expect(map.get('lake-b')?.id).toBe('b-failed');
  });
});
