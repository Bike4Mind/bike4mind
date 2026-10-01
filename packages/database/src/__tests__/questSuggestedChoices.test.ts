import { describe, it, expect, beforeEach } from 'vitest';
import { Quest } from '../models/content/QuestModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

const options = [
  { label: 'Reformulate', description: 'Re-formulate with all three pools.' },
  { label: 'Extend', description: 'Extend the loaded brief.' },
];

beforeEach(async () => {
  await Quest.deleteMany({});
});

describe('Quest.suggestedChoices', () => {
  it('round-trips options and the picked index without per-option ids', async () => {
    const created = await Quest.create({
      sessionId: 'sess-choices',
      timestamp: new Date(),
      type: 'message',
      prompt: 'p',
      reply: 'r',
      suggestedChoices: { options },
    });

    await Quest.updateOne({ _id: created._id }, { $set: { 'suggestedChoices.selectedIndex': 1 } });

    const stored = (await Quest.findById(created._id))!.toJSON();
    expect(stored.suggestedChoices).toEqual({ options, selectedIndex: 1 });
  });

  it('is absent on a quest that offered no choices', async () => {
    const created = await Quest.create({
      sessionId: 'sess-choices',
      timestamp: new Date(),
      type: 'message',
      prompt: 'p',
    });
    expect((await Quest.findById(created._id))!.toJSON().suggestedChoices).toBeUndefined();
  });
});
