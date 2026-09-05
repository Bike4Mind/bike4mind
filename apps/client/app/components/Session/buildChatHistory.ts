import type { IChatHistoryItem } from '@bike4mind/common';

type BuildChatHistoryOptions = {
  search: string;
  showPinnedOnly: boolean;
  activeStreamingQuestId: string | null;
  streamingMessageData: IChatHistoryItem | null;
};

/** Drop only genuinely broken quests. Voice transcripts are kept even with an empty
 *  prompt; optimistic quests are kept as long as they carry one. */
const isRenderable = (message: IChatHistoryItem) =>
  !!message &&
  (!!message.conversationItemId ||
    message.type === 'voice_transcript' ||
    (message.prompt !== null && message.prompt !== undefined && typeof message.prompt === 'string'));

const matchesSearch = (message: IChatHistoryItem, lowCaseSearch: string) =>
  message.prompt.toLowerCase().includes(lowCaseSearch) ||
  (message?.replies ?? []).some(r => r.toLowerCase().includes(lowCaseSearch));

/**
 * The list SessionMiddle renders: `flattenQuests` filtered, with the streaming quest
 * seated last so no filter can drop it.
 *
 * Seating last is load-bearing. The streaming quest hosts the live reply body and the
 * rapid-reply bubble, and a running turn matches neither a pin nor a search of the reply
 * it has not written yet - filtering after seating drops the turn the user is waiting on.
 *
 * Substitute when the list already holds the quest: that keeps the MessageContent
 * instance stable across the streaming -> completed handoff, so the node never remounts
 * mid-answer. Insert when it does not - useStreamingMessageMerge builds a quest from the
 * socket alone when chunks beat React Query to it (fresh sessions), and substituting
 * alone would render that turn nowhere at all.
 *
 * Newest-first; ChatHistory reverses it for display.
 */
export function buildChatHistory(
  flattenQuests: IChatHistoryItem[],
  { search, showPinnedOnly, activeStreamingQuestId, streamingMessageData }: BuildChatHistoryOptions
): IChatHistoryItem[] {
  let filtered = flattenQuests.filter(isRenderable);

  if (showPinnedOnly) {
    filtered = filtered.filter(message => message.pinned === true);
  }

  if (search.trim()) {
    const lowCaseSearch = search.toLowerCase();
    filtered = filtered.filter(message => matchesSearch(message, lowCaseSearch));
  }

  if (!activeStreamingQuestId || !streamingMessageData) return filtered;

  return filtered.some(q => q.id === activeStreamingQuestId)
    ? filtered.map(q => (q.id === activeStreamingQuestId ? streamingMessageData : q))
    : [streamingMessageData, ...filtered];
}
