/**
 * Database searcher for deep research
 * Searches the quests (chat history items) collection on the prompt field
 */

// @ts-ignore - types may not be exported in types yet
import type { Searcher, SearchResult } from '@bike4mind/services';
import type { IChatHistoryItemRepository, IChatHistoryItemDocument } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

export interface DatabaseSearcherOptions {
  questsRepository: IChatHistoryItemRepository;
  userId: string;
  limit?: number;
}

/**
 * Creates a database searcher that searches the quests collection prompt field
 * @param options Configuration options for the database searcher
 * @returns A Searcher implementation
 */
export function createDatabaseSearcher(options: DatabaseSearcherOptions): Searcher {
  const { questsRepository, userId, limit = 10 } = options;

  return {
    name: 'Internal Database',
    search: async (query: string): Promise<SearchResult[]> => {
      try {
        console.log(`Database Searcher query: ${query}`);
        const questsPromise = questsRepository.find({
          'promptMeta.session.userId': userId,
          prompt: { $regex: escapeRegex(query), $options: 'i' },
        });

        const quests = await questsPromise;

        // Sort and limit manually since Mongoose query doesn't support chaining
        const sortedQuests = quests.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);

        return sortedQuests.map((quest: IChatHistoryItemDocument) => ({
          title: `Quest: ${quest.prompt.substring(0, 100)}${quest.prompt.length > 100 ? '...' : ''}`,
          description: `From session on ${quest.timestamp.toLocaleDateString()}`,
          content: `Prompt: ${quest.prompt}\n\nReply: ${quest.reply || 'No reply'}`,
          url: `/notebooks/${quest.sessionId}?questId=${quest.id}`, // Path to the quest in the notebook
          type: 'database',
        }));
      } catch (error) {
        console.error('Database search error:', error);
        return [];
      }
    },
    // extractContent is not needed since search() already returns content
  };
}
