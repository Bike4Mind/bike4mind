import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { swapOptimisticPromptBubbleId, createOptimisticPromptBubble, appendReplyToLatestOptimisticBubble } from './llm';

const sessionId = 'sess_abc';
const queryKey = ['quests', 'session', sessionId];

function makeQuest(overrides: Partial<IChatHistoryItemDocument>): IChatHistoryItemDocument {
  return {
    id: 'placeholder',
    sessionId,
    type: 'message',
    prompt: 'hello',
    replies: [],
    images: [],
    status: 'done',
    timestamp: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function seedQueryClient(quests: IChatHistoryItemDocument[]): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(queryKey, {
    pages: [{ data: quests, hasMore: false }],
    pageParams: [{ page: 1 }],
  });
  return qc;
}

function readQuests(qc: QueryClient): IChatHistoryItemDocument[] {
  const data = qc.getQueryData(queryKey) as { pages: Array<{ data: IChatHistoryItemDocument[] }> } | undefined;
  return data?.pages.flatMap(p => p.data) ?? [];
}

// The AutoRouteBadge reads messageData.routingSource. To render live (not only
// after a reload), the optimistic bubble must carry the source at dispatch, and
// it must survive the reply-append patch on completion.
describe('createOptimisticPromptBubble routingSource (live badge)', () => {
  it('stamps routingSource onto the optimistic bubble when provided', () => {
    const qc = seedQueryClient([]);
    createOptimisticPromptBubble(qc, sessionId, 'analyze and compare the 2020 data', 'complexity');
    const quests = readQuests(qc);
    expect(quests).toHaveLength(1);
    expect(quests[0].routingSource).toBe('complexity');
  });

  it('omits routingSource for a normal (quest_processor) send', () => {
    const qc = seedQueryClient([]);
    createOptimisticPromptBubble(qc, sessionId, 'hi');
    expect(readQuests(qc)[0].routingSource).toBeUndefined();
  });

  it('preserves routingSource when the reply is appended on completion (badge stays live)', () => {
    const qc = seedQueryClient([]);
    createOptimisticPromptBubble(qc, sessionId, 'analyze and compare the 2020 data', 'complexity');
    appendReplyToLatestOptimisticBubble(qc, sessionId, 'the answer', 'exec_1');
    const quest = readQuests(qc)[0];
    expect(quest.routingSource).toBe('complexity');
    expect(quest.replies).toEqual(['the answer']);
  });
});

// The credits chip reads messageData.creditsUsed. On agent completion the
// value must ride the reply-append patch so the chip renders in-session,
// not only after the change-stream Quest replaces the optimistic bubble.
describe('appendReplyToLatestOptimisticBubble creditsUsed (live chip)', () => {
  it('patches creditsUsed onto the completed bubble when provided', () => {
    const qc = seedQueryClient([makeQuest({ id: 'optimistic-quest-1', replies: [] })]);
    appendReplyToLatestOptimisticBubble(qc, sessionId, 'the answer', 'exec_1', undefined, 42);
    expect(readQuests(qc)[0].creditsUsed).toBe(42);
  });

  it('patches a zero total (genuinely free run) rather than dropping it', () => {
    const qc = seedQueryClient([makeQuest({ id: 'optimistic-quest-1', replies: [] })]);
    appendReplyToLatestOptimisticBubble(qc, sessionId, 'the answer', 'exec_1', undefined, 0);
    expect(readQuests(qc)[0].creditsUsed).toBe(0);
  });

  it('leaves creditsUsed unset when no total is provided', () => {
    const qc = seedQueryClient([makeQuest({ id: 'optimistic-quest-1', replies: [] })]);
    appendReplyToLatestOptimisticBubble(qc, sessionId, 'the answer', 'exec_1');
    expect(readQuests(qc)[0].creditsUsed).toBeUndefined();
  });
});

describe('swapOptimisticPromptBubbleId', () => {
  it('renames the optimistic bubble to the real id when no collision exists', () => {
    const optimistic = makeQuest({ id: 'optimistic-quest-sess_abc-12345', prompt: 'do the thing' });
    const qc = seedQueryClient([optimistic]);

    swapOptimisticPromptBubbleId(qc, sessionId, 'real_quest_id');

    const quests = readQuests(qc);
    expect(quests).toHaveLength(1);
    expect(quests[0].id).toBe('real_quest_id');
    expect(quests[0].prompt).toBe('do the thing');
  });

  it('drops the optimistic bubble when the real id is already present (change-stream race)', () => {
    const optimistic = makeQuest({ id: 'optimistic-quest-sess_abc-12345', prompt: 'do the thing' });
    const real = makeQuest({ id: 'real_quest_id', prompt: 'do the thing' });
    const qc = seedQueryClient([optimistic, real]);

    swapOptimisticPromptBubbleId(qc, sessionId, 'real_quest_id');

    const quests = readQuests(qc);
    expect(quests).toHaveLength(1);
    expect(quests[0].id).toBe('real_quest_id');
  });

  it('is a no-op when no optimistic bubble exists in the session', () => {
    const real = makeQuest({ id: 'real_quest_id', prompt: 'do the thing' });
    const qc = seedQueryClient([real]);

    swapOptimisticPromptBubbleId(qc, sessionId, 'different_real_id');

    const quests = readQuests(qc);
    expect(quests).toHaveLength(1);
    expect(quests[0].id).toBe('real_quest_id');
  });

  it('is a no-op when the cache key is empty', () => {
    const qc = new QueryClient();
    expect(() => swapOptimisticPromptBubbleId(qc, sessionId, 'real_quest_id')).not.toThrow();
    expect(qc.getQueryData(queryKey)).toBeUndefined();
  });

  it('only touches the matching session — sibling sessions are untouched', () => {
    const optimistic = makeQuest({ id: 'optimistic-quest-sess_abc-12345', prompt: 'do the thing' });
    const qc = seedQueryClient([optimistic]);
    // Seed an unrelated session that also has an optimistic-looking entry
    const otherKey = ['quests', 'session', 'sess_xyz'];
    const otherOptimistic = makeQuest({
      id: 'optimistic-quest-sess_xyz-99999',
      sessionId: 'sess_xyz',
      prompt: 'unrelated',
    });
    qc.setQueryData(otherKey, {
      pages: [{ data: [otherOptimistic], hasMore: false }],
      pageParams: [{ page: 1 }],
    });

    swapOptimisticPromptBubbleId(qc, sessionId, 'real_quest_id');

    const otherData = qc.getQueryData(otherKey) as { pages: Array<{ data: IChatHistoryItemDocument[] }> } | undefined;
    expect(otherData?.pages[0].data[0].id).toBe('optimistic-quest-sess_xyz-99999');
  });
});
