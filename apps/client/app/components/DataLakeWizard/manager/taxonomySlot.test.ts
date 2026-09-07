import { describe, it, expect } from 'vitest';
import { TAXONOMY_ATTENTION_STATUSES } from '@bike4mind/common';
import type { IDataLakeBatchSummary } from '@bike4mind/common';
import { selectTaxonomyBatchByLakeId } from './taxonomySlot';

/** Only the three fields the selector reads; the summary type is far wider than this. */
const batch = (overrides: Partial<IDataLakeBatchSummary> & { id: string }) =>
  ({ dataLakeId: 'lake-a', ...overrides }) as IDataLakeBatchSummary;

const pick = (batches: IDataLakeBatchSummary[], lakeId = 'lake-a') =>
  selectTaxonomyBatchByLakeId(batches).get(lakeId)?.id;

/** Every pair of attention statuses, higher-priority first. Kept whole by the count assertion below. */
const ORDER_PAIRS = [
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
] as const;

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

  // Arrival order is only sorted for the taxonomy-attention half of the merged server list, so
  // an ineligible batch can land after the winner. Skipping it must leave the slot alone.
  it('ignores an applied batch that arrives after the ready one', () => {
    expect(pick([batch({ id: 'b1', taxonomyStatus: 'ready' }), batch({ id: 'ap2', taxonomyStatus: 'applied' })])).toBe(
      'b1'
    );
  });

  // Both arrival orders per pair. Each relation is argued in SLOT_PRIORITY's docblock from which
  // consumer gate the status can render, so an unnoticed reshuffle is a real regression - e.g.
  // 'analyzing' above 'failed' deletes the failed-review affordance. The 'w'/'l' ids are
  // load-bearing: the id tie-break sorts ascending and would answer 'l', so a collapsed rank
  // cannot pass by accident.
  it.each(ORDER_PAIRS)('prefers %s over %s regardless of arrival order', (winner, loser) => {
    const w = batch({ id: 'w', taxonomyStatus: winner });
    const l = batch({ id: 'l', taxonomyStatus: loser });
    expect(pick([w, l])).toBe('w');
    expect(pick([l, w])).toBe('w');
  });

  // The eligibility table above grows off the server constant on its own; this hand-written one
  // does not, so a sixth attention status would stay eligible with its rank unpinned. Only the
  // count notices, and dropping a row also silently drops a test from the suite total.
  it('covers every pair of attention statuses', () => {
    const n = TAXONOMY_ATTENTION_STATUSES.length;
    expect(ORDER_PAIRS).toHaveLength((n * (n - 1)) / 2);
  });

  // Three-plus active batches on one lake is ordinary; every one has to be scanned, not just the
  // ends of the list. Ids are picked so a rank that collapsed to the id tie-break answers a loser.
  it('scans every batch when a lake has three active ones, in either arrival order', () => {
    const ready = batch({ id: 'b-ready', taxonomyStatus: 'ready' });
    const queued = batch({ id: 'a-queued', taxonomyStatus: 'queued' });
    const applying = batch({ id: 'c-applying', taxonomyStatus: 'applying' });
    expect(pick([ready, queued, applying])).toBe('b-ready');
    expect(pick([queued, applying, ready])).toBe('b-ready');
  });

  // Two ready siblings on one lake is legal; the winner must not depend on arrival order, and
  // must not move when an unrelated ingest write touches the batch. updatedAt runs OPPOSITE to
  // the id order on purpose: it is the key the module docblock rules out, and with the two keys
  // agreeing this test cannot tell one from the other.
  it('breaks a rank tie by id ascending, stably across input order', () => {
    const a = batch({ id: 'aaa', taxonomyStatus: 'ready', updatedAt: new Date('2026-01-01') });
    const z = batch({ id: 'zzz', taxonomyStatus: 'ready', updatedAt: new Date('2020-01-01') });
    expect(pick([z, a])).toBe('aaa');
    expect(pick([a, z])).toBe('aaa');
  });

  // The poll-stability property the id key exists for: ingest bumps updatedAt per file on a clock
  // independent of taxonomy, so a winner that tracked it would swap the review chip's batch out
  // from under the user between 10s polls.
  it('keeps the same tie winner when an ingest write bumps only updatedAt', () => {
    const a = batch({ id: 'aaa', taxonomyStatus: 'ready', updatedAt: new Date('2020-01-01') });
    const z = batch({ id: 'zzz', taxonomyStatus: 'ready', updatedAt: new Date('2020-01-02') });
    expect(pick([a, z])).toBe('aaa');
    expect(pick([{ ...a, updatedAt: new Date('2026-01-01') }, z])).toBe('aaa');
  });

  // The server route dedupes by id, so this should not arrive - but `<` vs `<=` in outranks is a
  // one-character edit, and last-wins on a tie is exactly the poll instability the id key prevents.
  // Asserted by identity: two batches sharing an id are indistinguishable by id alone.
  it('keeps the first of two batches sharing an id', () => {
    const first = batch({ id: 'dup', taxonomyStatus: 'ready' });
    const second = batch({ id: 'dup', taxonomyStatus: 'ready' });
    expect(selectTaxonomyBatchByLakeId([first, second]).get('lake-a')).toBe(first);
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
