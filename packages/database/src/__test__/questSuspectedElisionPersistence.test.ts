import { describe, it, expect } from 'vitest';
import { Quest } from '../models/content/QuestModel';
import { setupMongoTest } from './utils';

// Round-trip persistence test for promptMeta.suspectedElision, the same bug class as
// questTokenUsagePersistence.test.ts: Mongoose strict mode silently strips any field the Zod
// PromptMetaSchema allows but the QuestModel sub-schema does not declare. suspectedElision was lost
// exactly this way - the client's fallback scan kept producing the banner, so the dead server path
// stayed invisible through manual QA and five automated reviews.
describe('Quest promptMeta.suspectedElision persistence', () => {
  setupMongoTest();

  it('persists the whole verdict through a real save/read cycle', async () => {
    const quest = new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: {
        session: { id: 'session1', userId: 'user1' },
        suspectedElision: {
          confidence: 'high',
          signalCount: 12,
          details: ['placeholder_comment: for brevity (line 4)', '(+2 more not shown)'],
        },
      },
    });
    await quest.save();

    const readBack = await Quest.findById(quest._id).lean();
    expect(readBack?.promptMeta?.suspectedElision).toMatchObject({
      confidence: 'high',
      signalCount: 12,
      details: ['placeholder_comment: for brevity (line 4)', '(+2 more not shown)'],
    });
  });

  it('persists the low-confidence verdict with an empty details list', async () => {
    const quest = new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: {
        session: { id: 'session1', userId: 'user1' },
        suspectedElision: { confidence: 'low', signalCount: 2, details: [] },
      },
    });
    await quest.save();

    const readBack = await Quest.findById(quest._id).lean();
    expect(readBack?.promptMeta?.suspectedElision?.confidence).toBe('low');
    expect(readBack?.promptMeta?.suspectedElision?.signalCount).toBe(2);
    expect(readBack?.promptMeta?.suspectedElision?.details).toEqual([]);
  });

  it('does NOT enum-constrain confidence at the schema - stores it verbatim', async () => {
    // Deliberate: confidence carries no Mongoose `enum`, matching the rule the whole PromptMetaSchema
    // follows - BaseRepository.create runs validators, so an enum would turn an unexpected value into
    // a THROWN quest-creation on the completion path, and this advisory field must never eat a
    // completed reply. Zod's `suspectedElision` is the layer that constrains it to 'high' | 'low';
    // the schema's only job is not to lose the value. If someone re-adds the enum, this test explains
    // why it should come back out.
    const quest = new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: {
        session: { id: 'session1', userId: 'user1' },
        suspectedElision: { confidence: 'maybe', signalCount: 1, details: [] },
      },
    });
    await expect(quest.save()).resolves.toBeTruthy();
    const readBack = await Quest.findById(quest._id).lean();
    expect(readBack?.promptMeta?.suspectedElision?.confidence).toBe('maybe');
  });

  it('leaves suspectedElision absent when the scan found nothing', async () => {
    const quest = new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: { session: { id: 'session1', userId: 'user1' } },
    });
    await quest.save();

    const readBack = await Quest.findById(quest._id).lean();
    expect(readBack?.promptMeta?.suspectedElision).toBeUndefined();
  });
});
