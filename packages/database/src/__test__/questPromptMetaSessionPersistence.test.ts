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
 *
 * The second block below covers `prompt`, which had the same gap through a different creator -
 * a required field the unvalidated writes can omit, so a copy of such a quest died on
 * validation no matter what the copy path did about promptMeta.
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

  it('accepts create() of a quest that has no promptMeta at all', async () => {
    // The copy paths deliberately do NOT invent a promptMeta for a source quest that has none
    // (rebindPromptMetaSession returns undefined). Asserted here against the real schema, not
    // just at the unit-mock level, so "absent is fine" is pinned by the store itself.
    const created = await questRepository.create({
      sessionId: 'forked-session',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal quest shape for this test
    } as any);

    expect(created.promptMeta).toBeUndefined();
  });
});

/**
 * Same asymmetry, one field over. `ChatHistoryItemSchema.prompt` was `required: true`, but the
 * writes that can create a quest without one bypass validators entirely:
 * `upsertBySessionIdAndConversationItemId` (a bare upsert, used by the voice transcript handler,
 * whose assistant branch only ever sets replies/status/type/timestamp) and `update()`. Prompt-less
 * quests are therefore normal on disk - 17 of 55 in one local database - and a copy of one died on
 * `prompt: Path 'prompt' is required.` before the promptMeta rebind could matter.
 *
 * Note `prompt: quest.prompt ?? ''` is NOT a fix: Mongoose's `required` on a String rejects '' too.
 * The field is now `required: false`, which is what the data has always said.
 */
describe('Quest prompt write-path asymmetry', () => {
  setupMongoTest();

  it('lets the unvalidated upsert create a quest with no prompt', async () => {
    const upserted = await questRepository.upsertBySessionIdAndConversationItemId('session1', 'item-1', {
      replies: ['assistant said this'],
      status: 'done',
      type: 'voice_transcript',
      timestamp: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the voice handler's exact partial write
    } as any);

    expect(upserted?.prompt).toBeUndefined();
  });

  it('accepts create() of a copy of a prompt-less quest', async () => {
    const created = await questRepository.create({
      sessionId: 'forked-session',
      timestamp: new Date(),
      type: 'voice_transcript',
      replies: ['assistant said this'],
      promptMeta: { session: { id: 'forked-session', userId: 'user1' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproducing the copied prompt-less shape
    } as any);

    expect(created.prompt).toBeUndefined();
    expect(created.replies).toEqual(['assistant said this']);
  });
});
