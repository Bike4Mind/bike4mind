import { visibleReplyText } from '@bike4mind/common';

/**
 * The text a `streamed_chat_completion` frame shows the user. A streamed answer arrives in
 * `quest.replies` with `quest.reply` left null (ChatCompletionProcess); `reply` is filled only on
 * the error and notice paths. Slots are reduced to their visible text and joined the way
 * extractReplies (packages/server-utils/src/shared/replyUtils.ts) does, so a reasoning model's
 * hidden thinking does not count as streamed text.
 */
export function frameReplyText(quest: Record<string, unknown>): string {
  const slots = Array.isArray(quest.replies) ? quest.replies.filter(slot => typeof slot === 'string') : [];
  if (slots.length > 0) return slots.map(slot => visibleReplyText(slot)).join('');
  return typeof quest.reply === 'string' ? visibleReplyText(quest.reply) : '';
}
