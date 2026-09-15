import { describe, it, expect } from 'vitest';
import { Quest } from '../models/content/QuestModel';
import { UsageEvent } from '../models/billing/UsageEventModel';
import { setupMongoTest } from './utils';

// Round-trip persistence test for the billing audit fields on
// promptMeta.tokenUsage. Mongoose strict mode silently strips any field the
// Zod PromptMetaTokenUsageSchema allows but the QuestModel sub-schema does not
// declare - a class of bug the mocked-db ChatCompletion tests structurally
// cannot catch (settledBasis was lost exactly this way).
describe('Quest promptMeta.tokenUsage persistence', () => {
  setupMongoTest();

  it('persists every billing audit field through a real save/read cycle', async () => {
    const quest = new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: {
        session: { id: 'session1', userId: 'user1' },
        tokenUsage: {
          inputTokens: 80,
          outputTokens: 40,
          totalTokens: 120,
          actualInputTokens: 100,
          actualOutputTokens: 50,
          cacheReadInputTokens: 30,
          estimatedCost: 0.0025,
          creditsUsed: 5,
          settledBasis: 'provider',
        },
      },
    });
    await quest.save();

    const readBack = await Quest.findById(quest._id).lean();
    const tokenUsage = readBack?.promptMeta?.tokenUsage;
    expect(tokenUsage).toBeDefined();
    expect(tokenUsage).toMatchObject({
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
      actualInputTokens: 100,
      actualOutputTokens: 50,
      cacheReadInputTokens: 30,
      estimatedCost: 0.0025,
      creditsUsed: 5,
      settledBasis: 'provider',
    });
  });

  it('rejects values outside the settledBasis enum', async () => {
    const quest = new Quest({
      sessionId: 'session1',
      timestamp: new Date(),
      type: 'message',
      prompt: 'Hello',
      promptMeta: { session: { id: 'session1', userId: 'user1' }, tokenUsage: { settledBasis: 'guesswork' } },
    });
    await expect(quest.save()).rejects.toThrow(/settledBasis/);
  });

  it('persists settledBasis and writtenOffCredits on the usage event', async () => {
    const event = new UsageEvent({
      requestId: 'quest1',
      userId: 'user1',
      ownerId: 'user1',
      ownerType: 'User',
      feature: 'chat',
      provider: 'openai',
      model: 'gpt-4.1',
      inputTokens: 80,
      outputTokens: 40,
      providerInputTokens: 100,
      providerOutputTokens: 50,
      settledBasis: 'provider',
      costUsd: 0.0025,
      creditsCharged: 5,
      writtenOffCredits: 2,
    });
    await event.save();

    const readBack = await UsageEvent.findById(event._id).lean();
    expect(readBack?.settledBasis).toBe('provider');
    expect(readBack?.writtenOffCredits).toBe(2);
    expect(readBack?.creditsCharged).toBe(5);
  });
});
