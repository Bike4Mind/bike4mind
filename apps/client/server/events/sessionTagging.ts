import { questRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { IMessage } from '@bike4mind/common';
import { OperationsModelService } from '@client/services/operationsModelService';
import { withEventContext } from '@server/events/utils';
import { SessionEvents } from '@server/utils/eventBus';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { recordSessionOperationalUsage } from '@server/events/recordSessionOperationalUsage';

/**
 * Attempt to extract and parse JSON array from LLM response
 * Handles common LLM formatting issues like trailing commas, markdown code blocks, etc.
 */
function parseTagsFromLLMResponse(text: string | undefined | null): Array<{ name: string; strength: number }> | null {
  if (!text) return null;

  // Remove markdown code blocks if present
  const cleanedText = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Try to extract JSON array (use non-greedy to match first complete array)
  const arrayMatch = cleanedText.match(/\[[\s\S]*?\]/);
  if (!arrayMatch) return null;

  let jsonText = arrayMatch[0];

  // Fix common JSON issues from LLMs
  // 1. Remove trailing commas before ] or }
  jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');

  // 2. Fix unquoted property names (simple cases)
  jsonText = jsonText.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

  // 3. Replace single quotes with double quotes for string values
  // Be careful not to break already valid JSON
  jsonText = jsonText.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return null;

    // Validate and normalize the structure
    return parsed
      .filter(tag => tag && typeof tag === 'object' && tag.name)
      .map(tag => ({
        name: String(tag.name).trim(),
        strength: Math.min(Math.max(Number(tag.strength) || 5, 1), 10),
      }));
  } catch {
    // If standard parsing fails, try a more aggressive cleanup
    try {
      // Remove any non-JSON content before/after the array
      const strictArrayMatch = jsonText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (strictArrayMatch) {
        const strictJson = strictArrayMatch[0].replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(strictJson);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(tag => tag && typeof tag === 'object' && tag.name)
            .map(tag => ({
              name: String(tag.name).trim(),
              strength: Math.min(Math.max(Number(tag.strength) || 5, 1), 10),
            }));
        }
      }
    } catch {
      // Final fallback failed
    }
    return null;
  }
}

export const handler = withEventContext(async (event, logger) => {
  const body = SessionEvents.Tag.schema.parse(event.properties);
  const { sessionId, userId } = body;

  logger.updateMetadata({
    sessionId,
    userId,
  });

  const session = await sessionRepository.findById(sessionId);
  if (!session) {
    logger.warn(`Session not found: ${sessionId}`);
    return;
  }

  const user = await userRepository.findById(userId ?? session.userId);
  if (!user) {
    logger.error(`User not found`);
    return;
  }

  logger.info(`Handling tagging job for session ${sessionId} (as user ${user.id})`);

  // Skip if session already has tags, unless it's been a while (duplicate-processing guard)
  if (session.tags && session.tags.length > 0) {
    if (session.updatedAt) {
      const timeSinceLastUpdate = Date.now() - new Date(session.updatedAt).getTime();
      if (timeSinceLastUpdate < 10000) {
        // 10 seconds
        logger.info(
          'Session tags were updated very recently, likely being processed by another handler, skipping (duplicate prevention)',
          {
            sessionId,
            timeSinceLastUpdateSec: Math.round(timeSinceLastUpdate / 1000),
          }
        );
        return;
      }
    }
  }

  const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel();
  logger.info(`Using operations model for tagging: ${modelInfo.name} (${modelInfo.backend})`);

  // Find the first Quest document submitted by the user from the Session
  const quest = await questRepository.findOne({ sessionId: session.id });
  if (!quest) {
    // This is expected for empty notebooks - mark as tagged with empty tags and return gracefully
    logger.info(`No quests found for session ${sessionId} - marking as tagged with empty tags`);
    session.tags = [];
    session.taggedAt = new Date();
    await sessionRepository.update(session);
    return;
  }

  // Ask an LLM to tag the user's first Quest
  logger.info(`Tagging based on Quest ${quest.id}`);

  const messages: IMessage[] = [
    {
      role: 'system',
      content:
        'Generate a structure for a word cloud based on the following ' +
        'prompt and summary. The result should be a JSON array without any exposition, ' +
        'and each tag should have a "name" and numeric "strength" field. The strength ' +
        'value must be between 1 and 10, where 1 represents lowest relevance and 10 ' +
        'represents highest relevance.',
    },
    {
      role: 'user',
      content: `Prompt: ${quest.prompt}\nSession Summary: ${session.summary || 'No summary available'}`,
    },
  ];

  const options = {
    stream: false,
  };

  const completionBuffers: string[] = [];
  let lastCompletionInfo: CompletionInfo | undefined;
  const completionStartTime = Date.now();

  await llm.complete(modelId, messages, options, async (chunk: any[], completionInfo?: CompletionInfo) => {
    chunk.forEach((part: string | null | undefined, index: number) => {
      if (part === undefined || part === null) return;
      completionBuffers[index] = (completionBuffers[index] ?? '') + part;
    });
    if (completionInfo) lastCompletionInfo = completionInfo;
  });

  await recordSessionOperationalUsage({
    user,
    sessionId,
    modelId,
    modelInfo,
    completionInfo: lastCompletionInfo,
    startTime: completionStartTime,
    logger,
  });

  const tagsText = completionBuffers
    .map(text => text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n');

  const parsedTags = parseTagsFromLLMResponse(tagsText);

  if (parsedTags && parsedTags.length > 0) {
    session.tags = parsedTags;
    session.taggedAt = new Date();
    logger.info(`Tags: ${JSON.stringify(session.tags)}`);
    await sessionRepository.update(session);
  } else {
    // Log the failure but don't throw - mark as attempted
    logger.warn(`Failed to parse tags from LLM response for session ${sessionId}`);
    logger.debug(`Raw LLM response: ${tagsText?.substring(0, 500)}${(tagsText?.length || 0) > 500 ? '...' : ''}`);

    // Mark as tagged with empty tags to prevent retry loops
    session.tags = [];
    session.taggedAt = new Date();
    await sessionRepository.update(session);
  }
});
