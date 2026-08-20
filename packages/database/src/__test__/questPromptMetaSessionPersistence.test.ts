import { describe, it, expect } from 'vitest';
import { Quest, questRepository } from '../models/content/QuestModel';
import { setupMongoTest } from './utils';

/**
 * The asymmetry behind the prod fork 500 (`POST /api/sessions/:id/chat/:messageId/fork` ->
 * "Quest validation failed: promptMeta.session.userId: Path `session.userId` is required").
 *
 * `PromptMetaSchema.session.id`/`.userId` are `required: true` while the Zod contract makes the
 * whole `session` block optional, and only ONE quest write runs Mongoose validators:
 * `BaseRepository.create`. Live turn updates go through `update()` (findOneAndUpdate + $set,
 * validators off), and several writers materialize promptMeta from nothing on a quest that had
 * none, so a quest with promptMeta and NO session block persists fine and then blows up the
 * moment a copy path (fork/snip/clone) re-inserts it through create().
 *
 * These tests pin both halves so the write-path asymmetry stays visible: the copy paths must
 * supply the session block themselves (see rebindPromptMetaSession in @bike4mind/common).
 */
describe('Quest promptMeta.session write-path asymmetry', () => {
  setupMongoTest();

  const makeQuest = () =>
    new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: { session: { id: 'session1', userId: 'user1' } },
    });

  it('lets update() persist a promptMeta with no session block at all', async () => {
    const quest = makeQuest();
    await quest.save();

    // What ChatCompletionFeatures' `quest.promptMeta = quest.promptMeta ?? {}` writers and
    // addStatusToQuest produce on a quest created without promptMeta: a meta object that names
    // no session. update() does not pass runValidators, so this is accepted.
    await questRepository.update({
      id: quest._id.toString(),
      promptMeta: { warnings: ['Knowledge-base grounding scanned only part of the library.'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial promptMeta is the point of this test
    } as any);

    const readBack = await Quest.findById(quest._id).lean();
    expect(readBack?.promptMeta?.session).toBeUndefined();
    expect(readBack?.promptMeta?.warnings).toEqual(['Knowledge-base grounding scanned only part of the library.']);
  });

  it('rejects create() of a copy whose promptMeta names no session - the fork 500', async () => {
    await expect(
      questRepository.create({
        sessionId: 'forked-session',
        timestamp: new Date(),
        type: 'message',
        prompt: 'Hello',
        promptMeta: { warnings: ['carried over from the source quest'] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproducing the unrebound copy shape
      } as any)
    ).rejects.toThrow(/session\.userId/);
  });

  it('accepts create() of a copy once the session block is rebound to the destination', async () => {
    const created = await questRepository.create({
      sessionId: 'forked-session',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: {
        warnings: ['carried over from the source quest'],
        session: { id: 'forked-session', userId: 'user1' },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal quest shape for this test
    } as any);

    expect(created.promptMeta?.session).toMatchObject({ id: 'forked-session', userId: 'user1' });
  });
});
