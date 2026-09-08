import { describe, it, expect } from 'vitest';
import type { IChatHistoryItem } from '@bike4mind/common';
import { buildChatHistory } from './buildChatHistory';

const quest = (id: string, over: Partial<IChatHistoryItem> = {}) =>
  ({ id, prompt: `prompt ${id}`, replies: [], status: 'done', ...over }) as IChatHistoryItem;

const opts = (over: Partial<Parameters<typeof buildChatHistory>[1]> = {}) => ({
  search: '',
  showPinnedOnly: false,
  activeStreamingQuestId: null,
  streamingMessageData: null,
  ...over,
});

const ids = (list: IChatHistoryItem[]) => list.map(q => q.id);

describe('buildChatHistory', () => {
  describe('filtering', () => {
    it('drops quests with no usable prompt', () => {
      const kept = quest('ok');
      const broken = { id: 'broken' } as IChatHistoryItem;
      expect(ids(buildChatHistory([kept, broken], opts()))).toEqual(['ok']);
    });

    it('keeps a voice transcript despite an empty prompt', () => {
      const voice = { id: 'v', type: 'voice_transcript' } as IChatHistoryItem;
      expect(ids(buildChatHistory([voice], opts()))).toEqual(['v']);
    });

    it('keeps only pinned quests when the pinned filter is on', () => {
      const list = [quest('a', { pinned: true }), quest('b')];
      expect(ids(buildChatHistory(list, opts({ showPinnedOnly: true })))).toEqual(['a']);
    });

    it('matches the search term against prompt and replies', () => {
      const list = [quest('a', { prompt: 'about badgers' }), quest('b', { replies: ['mentions badgers'] }), quest('c')];
      expect(ids(buildChatHistory(list, opts({ search: 'BADGERS' })))).toEqual(['a', 'b']);
    });
  });

  describe('seating the streaming quest', () => {
    // Substituting rather than inserting is what keeps one MessageContent instance
    // across the streaming -> completed handoff, so the node never remounts mid-answer.
    it('substitutes in place when the history already holds the streaming quest', () => {
      const streaming = quest('b', { status: 'running', replies: ['partial'] });
      const result = buildChatHistory(
        [quest('b'), quest('a')],
        opts({ activeStreamingQuestId: 'b', streamingMessageData: streaming })
      );

      expect(ids(result)).toEqual(['b', 'a']);
      expect(result[0]).toBe(streaming);
    });

    // useStreamingMessageMerge builds a quest from the socket alone when chunks beat
    // React Query to it (fresh sessions). Substituting alone matched nothing, so the
    // turn - and the rapid-reply bubble that rides on it - rendered nowhere.
    it('inserts the streaming quest when the history does not have it yet', () => {
      const streaming = quest('new', { status: 'running', replies: ['first tokens'] });
      const result = buildChatHistory(
        [quest('a')],
        opts({ activeStreamingQuestId: 'new', streamingMessageData: streaming })
      );

      expect(ids(result)).toEqual(['new', 'a']);
      expect(result[0]).toBe(streaming);
    });

    it('seats the streaming quest into an empty history', () => {
      const streaming = quest('only', { status: 'running' });
      expect(buildChatHistory([], opts({ activeStreamingQuestId: 'only', streamingMessageData: streaming }))).toEqual([
        streaming,
      ]);
    });

    it('leaves the history alone when nothing is streaming', () => {
      expect(ids(buildChatHistory([quest('b'), quest('a')], opts()))).toEqual(['b', 'a']);
    });
  });

  // The seat must happen AFTER every filter. These are the cases that regress if the
  // order is swapped back: the running turn is unpinned and its reply is not written
  // yet, so both filters would drop it while the footer spinner still spins.
  describe('the streaming quest survives every filter', () => {
    it('survives the pinned filter', () => {
      const streaming = quest('b', { status: 'running', pinned: false });
      const result = buildChatHistory(
        [quest('a', { pinned: true }), quest('b')],
        opts({ showPinnedOnly: true, activeStreamingQuestId: 'b', streamingMessageData: streaming })
      );

      expect(ids(result)).toEqual(['b', 'a']);
    });

    it('survives a search term it cannot match', () => {
      const streaming = quest('b', { status: 'running', prompt: 'unrelated', replies: [] });
      const result = buildChatHistory(
        [quest('a', { prompt: 'about badgers' }), quest('b')],
        opts({ search: 'badgers', activeStreamingQuestId: 'b', streamingMessageData: streaming })
      );

      expect(ids(result)).toEqual(['b', 'a']);
    });

    it('survives the broken-quest filter when the socket is the only source', () => {
      const streaming = quest('sock', { status: 'running' });
      const result = buildChatHistory(
        [{ id: 'broken' } as IChatHistoryItem],
        opts({ activeStreamingQuestId: 'sock', streamingMessageData: streaming })
      );

      expect(ids(result)).toEqual(['sock']);
    });
  });
});
