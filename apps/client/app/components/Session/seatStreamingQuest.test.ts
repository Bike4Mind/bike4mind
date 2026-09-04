import { describe, it, expect } from 'vitest';
import type { IChatHistoryItem } from '@bike4mind/common';
import { seatStreamingQuest } from './seatStreamingQuest';

const quest = (id: string, over: Partial<IChatHistoryItem> = {}) =>
  ({ id, prompt: `prompt ${id}`, replies: [], status: 'done', ...over }) as IChatHistoryItem;

describe('seatStreamingQuest', () => {
  it('leaves the history alone when nothing is streaming', () => {
    const history = [quest('b'), quest('a')];
    expect(seatStreamingQuest(history, null, null)).toBe(history);
  });

  // Substituting rather than inserting is what keeps one MessageContent instance across
  // the streaming -> completed handoff, so the node never remounts mid-answer.
  it('substitutes in place when the history already holds the streaming quest', () => {
    const streaming = quest('b', { status: 'running', replies: ['partial'] });
    const result = seatStreamingQuest([quest('b'), quest('a')], 'b', streaming);

    expect(result.map(q => q.id)).toEqual(['b', 'a']);
    expect(result[0]).toBe(streaming);
  });

  // The merge builds a quest from the socket alone when chunks beat React Query to it
  // (fresh sessions). Substituting alone matched nothing, so the turn - and the
  // rapid-reply bubble that rides on it - rendered nowhere.
  it('inserts the streaming quest when the history does not have it yet', () => {
    const streaming = quest('new', { status: 'running', replies: ['first tokens'] });
    const result = seatStreamingQuest([quest('a')], 'new', streaming);

    expect(result.map(q => q.id)).toEqual(['new', 'a']);
    expect(result[0]).toBe(streaming);
  });

  it('seats the streaming quest into an empty history', () => {
    const streaming = quest('only', { status: 'running' });
    expect(seatStreamingQuest([], 'only', streaming)).toEqual([streaming]);
  });

  // A pin or search filter runs before this and would otherwise drop the running turn,
  // leaving a footer spinner with no message to spin over.
  it('re-seats a streaming quest that the filters removed', () => {
    const streaming = quest('b', { status: 'running' });
    const result = seatStreamingQuest([quest('a', { pinned: true })], 'b', streaming);

    expect(result.map(q => q.id)).toEqual(['b', 'a']);
  });
});
