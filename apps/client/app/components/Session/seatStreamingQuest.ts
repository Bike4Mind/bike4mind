import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * Seat the streaming quest in the rendered history, after every filter has run.
 *
 * The streaming quest hosts the live reply body and the rapid-reply bubble, so it has to
 * be present whatever the filters did: a running turn matches neither a pin nor a search
 * of the reply it has not written yet.
 *
 * Substitute when the list already holds the quest - that keeps the MessageContent
 * instance stable across the streaming -> completed handoff. Insert when it does not:
 * useStreamingMessageMerge builds a quest from the socket alone when chunks beat React
 * Query to it (fresh sessions), and substituting alone would render that turn nowhere.
 *
 * `history` is newest-first; ChatHistory reverses it for display.
 */
export function seatStreamingQuest(
  history: IChatHistoryItem[],
  activeStreamingQuestId: string | null,
  streamingMessageData: IChatHistoryItem | null
): IChatHistoryItem[] {
  if (!activeStreamingQuestId || !streamingMessageData) return history;

  return history.some(q => q.id === activeStreamingQuestId)
    ? history.map(q => (q.id === activeStreamingQuestId ? streamingMessageData : q))
    : [streamingMessageData, ...history];
}
