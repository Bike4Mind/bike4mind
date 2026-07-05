import { generateSafeEmbedding } from '@bike4mind/utils';
import { EmbeddingService } from '@bike4mind/fab-pipeline';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';

export async function parseQueryWithLLM(
  query: string,
  llm: ICompletionBackend,
  model: string,
  logger: Logger
): Promise<{
  intent: string;
  keywords: string[];
  filters?: { fileType?: string; dateRange?: string; tags?: string[] };
} | null> {
  const parseStartTime = Date.now();

  if (!llm) {
    // Fallback to simple keyword extraction
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2);
    return {
      intent: 'search',
      keywords,
    };
  }

  const systemPrompt = `You are a search query parser. Parse natural language queries and return structured data.

Extract:
1. User's intent (search, find, show, grab, get, etc.)
2. Main keywords for searching
3. Any filters mentioned (file types, date ranges, tags)

Return ONLY valid JSON with this structure:
{
  "intent": "search|find|show|grab|get",
  "keywords": ["keyword1", "keyword2"],
  "filters": {
    "fileType": "pdf|doc|txt|xlsx" (if mentioned),
    "dateRange": "recent|today|this week|last month" (if mentioned),
    "tags": ["tag1", "tag2"] (if mentioned)
  }
}`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: `Parse this query: "${query}"` },
  ];

  let result = '';

  try {
    await llm.complete(
      model,
      messages,
      {
        maxTokens: 200,
        temperature: 0.1,
        stream: false,
      },
      async chunks => {
        result += chunks[0] || '';
      }
    );

    // Try to parse the JSON response
    const cleanResult = result.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleanResult);

    logger.info(`Query parsed in ${Date.now() - parseStartTime}ms:`, parsed);
    return parsed;
  } catch (error) {
    logger.warn('LLM parsing failed, using fallback:', error);
    return null;
  }
}

export const getVector = async (
  embeddingProvider: EmbeddingService,
  text: string,
  logger: Logger
): Promise<number[]> => {
  // Safe embedding generation so FAB file chunks don't exceed embedding model token limits.
  const response = await generateSafeEmbedding(embeddingProvider, text, logger);
  return response;
};
