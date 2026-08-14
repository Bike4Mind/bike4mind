import { describe, it, expect } from 'vitest';
import { MementoTier, MementoType } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import Memento, { mementoRepository } from '../MementoModel';

const memento = (userId: string, summary: string) =>
  Memento.create({
    userId,
    type: MementoType.PROMPT,
    tier: MementoTier.HOT,
    weight: 100,
    summary,
    fullContent: `the original prompt behind: ${summary}`,
    embedding: [0.1, 0.2, 0.3],
    lastAccessedAt: new Date(),
  });

describe('MementoRepository.deleteAllByUserId', () => {
  setupMongoTest();

  it('hard-deletes every memento for the user - the V1 half of "delete my data"', async () => {
    // A memento cannot be crypto-shredded: its summary, full prompt and embedding are all plaintext
    // with no key to destroy. And the V2 unified read UNIONS these with the ledger, so anything left
    // behind is handed straight back into the next chat prompt. It has to actually go.
    await memento('u1', 'User favorite color is green');
    await memento('u1', 'User works in pharma');

    const deleted = await mementoRepository.deleteAllByUserId('u1');

    expect(deleted).toBe(2);
    expect(await mementoRepository.findByUserId('u1', {})).toEqual([]);
    // and the content is really gone from the collection, not merely hidden
    expect(await Memento.countDocuments({ userId: 'u1' })).toBe(0);
  });

  it('does not touch another users mementos', async () => {
    await memento('u1', 'mine');
    await memento('u2', 'theirs');

    const deleted = await mementoRepository.deleteAllByUserId('u1');

    expect(deleted).toBe(1);
    expect((await mementoRepository.findByUserId('u2', {})).map(m => m.summary)).toEqual(['theirs']);
  });

  it('is a no-op for a user with no mementos', async () => {
    expect(await mementoRepository.deleteAllByUserId('nobody')).toBe(0);
  });
});

describe('MementoRepository.deleteByIdsForUser', () => {
  setupMongoTest();

  it('deletes only the given ids, owner-scoped, leaving the rest', async () => {
    // The per-belief V2 shred uses this to remove the V1 memento backing (or twinning) a deleted
    // belief. It must delete exactly the targeted mementos and nothing else.
    const a = await memento('u1', 'keep me');
    const b = await memento('u1', 'delete me');
    const c = await memento('u1', 'also keep');

    const deleted = await mementoRepository.deleteByIdsForUser([String(b.id)], 'u1');

    expect(deleted).toBe(1);
    const remaining = (await mementoRepository.findByUserId('u1', {})).map(m => String(m.id)).sort();
    expect(remaining).toEqual([String(a.id), String(c.id)].sort());
  });

  it('will not delete another users memento even given its id', async () => {
    const mine = await memento('u1', 'mine');
    const theirs = await memento('u2', 'theirs');

    // u1 tries to delete u2's memento by passing its id - the ownerUserId scope blocks it.
    const deleted = await mementoRepository.deleteByIdsForUser([String(theirs.id)], 'u1');

    expect(deleted).toBe(0);
    expect(await Memento.countDocuments({ _id: theirs.id })).toBe(1);
    expect(await Memento.countDocuments({ _id: mine.id })).toBe(1);
  });

  it('is a no-op for an empty id list (never issues a delete that could match everything)', async () => {
    await memento('u1', 'safe');
    expect(await mementoRepository.deleteByIdsForUser([], 'u1')).toBe(0);
    expect(await Memento.countDocuments({ userId: 'u1' })).toBe(1);
  });
});

/**
 * `limit`/`afterId` exist so memento scoring can walk a user's mementos a page at a time instead of
 * hydrating all of them - each carries an embedding and its full original prompt. The paging has to
 * be exact (no gap, no repeat) or which mementos get scored starts depending on page boundaries.
 */
describe('MementoRepository.findByUserId keyset paging', () => {
  setupMongoTest();

  it('leaves an unpaged read unsorted and unlimited', async () => {
    // The other callers (userMementoMemoryStore, the memory-by-kind route) pass neither option and
    // must be unaffected: applying sort({_id:1}) unconditionally would change their query plan.
    await memento('u1', 'first');
    await memento('u1', 'second');
    await memento('u1', 'third');

    const rows = await mementoRepository.findByUserId('u1', {});

    expect(rows).toHaveLength(3);
  });

  it('pages by keyset with no gap and no duplicate', async () => {
    for (let i = 0; i < 7; i++) await memento('u1', `m-${i}`);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await mementoRepository.findByUserId('u1', { limit: 3, afterId: cursor });
      if (rows.length === 0) break;
      seen.push(...rows.map(m => m.summary));
      cursor = String(rows[rows.length - 1].id);
    }

    expect(seen).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6']);
    expect(new Set(seen).size).toBe(7);
  });

  it('a cursor excludes the row it names rather than repeating it', async () => {
    await memento('u1', 'a');
    await memento('u1', 'b');

    const [first] = await mementoRepository.findByUserId('u1', { limit: 1 });
    const next = await mementoRepository.findByUserId('u1', { limit: 5, afterId: String(first.id) });

    expect(first.summary).toBe('a');
    expect(next.map(m => m.summary)).toEqual(['b']);
  });

  it('stays scoped to the owner while paging', async () => {
    await memento('u1', 'mine-1');
    await memento('u2', 'theirs');
    await memento('u1', 'mine-2');

    const rows = await mementoRepository.findByUserId('u1', { limit: 10 });

    expect(rows.map(m => m.summary)).toEqual(['mine-1', 'mine-2']);
  });

  it('refuses a non-positive limit instead of serving an unbounded read', async () => {
    // Mongo reads .limit(0) as "no limit", so a caller asking for zero rows would get the sort applied
    // and then the whole collection - the exact failure this reader exists to prevent.
    await memento('u1', 'a');

    await expect(mementoRepository.findByUserId('u1', { limit: 0 })).rejects.toThrow(/limit must be positive/);
    await expect(mementoRepository.findByUserId('u1', { limit: -5 })).rejects.toThrow(/limit must be positive/);
  });

  it('serves the paged walk from an index with no in-memory sort', async () => {
    // The shape asserted here is the one production actually issues: getRelevantMementos defaults
    // tier to HOT and pages with a cursor, so `tier` is present as a residual filter and `_id` carries
    // both the range and the sort. Asserting the tier-less shape would leave the real query unpinned,
    // and `{ userId: 1, tier: 1, weight: -1 }` is a competing candidate whose plan needs a SORT.
    for (let i = 0; i < 60; i++) await memento('u1', `m-${i}`);
    await Memento.ensureIndexes();
    const [first] = await mementoRepository.findByUserId('u1', { limit: 1 });

    const plan = await Memento.collection
      .find({ userId: 'u1', tier: MementoTier.HOT, _id: { $gt: first._id } })
      .sort({ _id: 1 })
      .limit(3)
      .explain('queryPlanner');

    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    // Name the index: with only `_id_` present the planner satisfies sort({_id:1}) by an _id scan
    // plus fetch-and-filter, so asserting IXSCAN alone would pass with the compound index gone.
    expect(stages).toContain('"indexName":"userId_1__id_1"');
    expect(stages).not.toContain('"stage":"SORT"');
  });
});
