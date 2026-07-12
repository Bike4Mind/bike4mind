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
