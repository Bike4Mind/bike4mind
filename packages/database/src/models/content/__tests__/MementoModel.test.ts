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

  it('does not touch another user`s mementos', async () => {
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

  it('will not delete another user`s memento even given its id', async () => {
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
