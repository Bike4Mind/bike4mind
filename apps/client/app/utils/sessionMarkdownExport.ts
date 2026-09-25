import { stripSearchResultCardFences, type IChatHistoryItemDocument } from '@bike4mind/common';
import { visibleReplyForExport } from '@client/app/utils/replyUtils';

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
    const reply = visibleReplyForExport(quest);
    if (reply) {
      lines.push(`**AI:** ${stripSearchResultCardFences(reply, quest.promptMeta?.citables)}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
