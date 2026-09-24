import { stripSearchResultCardFences, type IChatHistoryItemDocument } from '@bike4mind/common';

/**
 * Converts an array of chat history items (quests) into a markdown string.
 * Expects quests in chronological order (oldest first).
 */
export function convertSessionToMarkdown(quests: IChatHistoryItemDocument[]): string {
  const lines: string[] = [];

  for (const quest of quests) {
    if (quest.prompt) {
      lines.push(`**User:** ${quest.prompt}`);
      lines.push('');
    }
    const replies = quest.replies?.length ? quest.replies : quest.reply ? [quest.reply] : [];
    for (const reply of replies) {
      if (reply) {
        lines.push(`**AI:** ${stripSearchResultCardFences(reply, quest.promptMeta?.citables)}`);
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
