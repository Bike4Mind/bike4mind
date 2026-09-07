import { describe, it, expect } from 'vitest';
import { TAXONOMY_ATTENTION_STATUSES } from '@bike4mind/common';
import type { IDataLakeBatchSummary } from '@bike4mind/common';
import { SLOT_PRIORITY, selectTaxonomyBatchByLakeId } from './taxonomySlot';

/** Only the four fields the selector reads; the summary type is far wider than this. */
const batch = (overrides: Partial<IDataLakeBatchSummary> & { id: string }) =>
  ({ dataLakeId: 'lake-a', ...overrides }) as IDataLakeBatchSummary;

const pick = (batches: IDataLakeBatchSummary[], lakeId = 'lake-a') =>
  selectTaxonomyBatchByLakeId(batches).get(lakeId)?.id;

describe('selectTaxonomyBatchByLakeId', () => {
  it('is a permutation of the server attention set - same members, no extras, no omissions', () => {
    expect([...SLOT_PRIORITY].sort()).toEqual([...TAXONOMY_ATTENTION_STATUSES].sort());
  });

  it('returns an empty map for an undefined list', () => {
    expect(selectTaxonomyBatchByLakeId(undefined).size).toBe(0);
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

  it('prefers the ready batch over an analyzing one that arrived first', () => {
    expect(pick([batch({ id: 'a1', taxonomyStatus: 'analyzing' }), batch({ id: 'b1', taxonomyStatus: 'ready' })])).toBe(
      'b1'
    );
  });

  // 'applying' matches no consumer gate, so it must not take the slot from a status that does.
  it('prefers analyzing over applying', () => {
    expect(
      pick([batch({ id: 'ap', taxonomyStatus: 'applying' }), batch({ id: 'an', taxonomyStatus: 'analyzing' })])
    ).toBe('an');
  });

  it('prefers ready over failed regardless of list order', () => {
    const ready = batch({ id: 'b1', taxonomyStatus: 'ready' });
    const failed = batch({ id: 'b0', taxonomyStatus: 'failed' });
    expect(pick([failed, ready])).toBe('b1');
    expect(pick([ready, failed])).toBe('b1');
  });

  // ISO strings, not Dates: that is what the list endpoint actually puts on the wire.
  it('breaks a rank tie by updatedAt desc, stably across input order', () => {
    const older = batch({ id: 'b1', taxonomyStatus: 'ready', updatedAt: '2026-01-01T00:00:00Z' as unknown as Date });
    const newer = batch({ id: 'b2', taxonomyStatus: 'ready', updatedAt: '2026-02-01T00:00:00Z' as unknown as Date });
    expect(pick([older, newer])).toBe('b2');
    expect(pick([newer, older])).toBe('b2');
  });

  it('breaks an exact tie by id ascending, stably across input order', () => {
    const a = batch({ id: 'aaa', taxonomyStatus: 'ready' });
    const z = batch({ id: 'zzz', taxonomyStatus: 'ready' });
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
