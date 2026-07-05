/**
 * Thread Intelligence: analyze a Slack thread into a summary, decisions,
 * action items, participants, sentiment, and attachments. Key-point
 * extraction falls back to pattern matching when no ChatCompletion is passed.
 */

import { ChatCompletionInvoke } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';

// Type exports
export type {
  SlackMessage,
  ThreadSummary,
  Decision,
  ActionItem,
  Participant,
  Attachment,
  ThreadIntelligence,
} from './types';

// Re-export main functions
export { extractTopics, detectDecisions, extractActionItems, extractAttachments } from './extractors';
export { analyzeSentiment, analyzeParticipants } from './analyzers';
export { formatThreadIntelligence, calculateTimeSpan } from './formatters';

// Internal imports
import { SlackMessage, ThreadIntelligence, ThreadSummary } from './types';
import {
  extractTopics,
  detectDecisions,
  extractActionItems,
  extractKeyPointsBasic,
  extractAttachments,
} from './extractors';
import { analyzeSentiment, analyzeParticipants } from './analyzers';
import { calculateTimeSpan } from './formatters';

// Main Analysis Function

/**
 * Analyzes a thread and returns comprehensive intelligence
 */
export async function analyzeThread(
  messages: SlackMessage[],
  chatCompletion?: ChatCompletionInvoke
): Promise<ThreadIntelligence> {
  Logger.info('Starting thread intelligence analysis', { messageCount: messages.length });

  // Extract basic information
  const summary = await summarizeThread(messages, chatCompletion);
  const decisions = detectDecisions(messages);
  const actionItems = extractActionItems(messages);
  const participants = analyzeParticipants(messages);
  const attachments = extractAttachments(messages);
  const sentiment = analyzeSentiment(messages);

  return {
    summary,
    decisions,
    actionItems,
    participants,
    attachments,
    sentiment,
  };
}

/**
 * Summarizes a thread by extracting main topics and key points
 */
export async function summarizeThread(
  messages: SlackMessage[],
  chatCompletion?: ChatCompletionInvoke
): Promise<ThreadSummary> {
  const topics = extractTopics(messages);
  const timeSpan = calculateTimeSpan(messages);
  const participants = new Set(messages.map(m => m.user));

  // If ChatCompletion is available, use AI to enhance the summary
  let keyPoints: string[] = [];
  if (chatCompletion) {
    keyPoints = await extractKeyPointsWithAI(messages, chatCompletion);
  } else {
    // Fallback: Extract key points using pattern matching
    keyPoints = extractKeyPointsBasic(messages);
  }

  return {
    mainTopics: topics,
    keyPoints: keyPoints.slice(0, 5), // Top 5 key points
    participantCount: participants.size,
    messageCount: messages.length,
    timeSpan,
  };
}

/**
 * Extracts key points using AI (stub for future implementation)
 */
async function extractKeyPointsWithAI(
  messages: SlackMessage[],
  chatCompletion: ChatCompletionInvoke
): Promise<string[]> {
  // Build a conversation context
  const conversationText = messages.map((m, i) => `${i + 1}. User ${m.user}: ${m.text}`).join('\n');

  const _prompt = `Analyze this Slack conversation and extract the 5 most important key points as bullet points:

${conversationText}

Return ONLY the key points, one per line, starting with a dash (-).`;

  try {
    // Stub: needs proper ChatCompletion integration; returns basic extraction for now
    Logger.info('AI-enhanced key point extraction not yet implemented, using basic extraction');
    Logger.debug('Prepared prompt for future AI integration', { promptLength: _prompt.length });
    return extractKeyPointsBasic(messages);
  } catch (error) {
    Logger.error('Error extracting key points with AI', error);
    return extractKeyPointsBasic(messages);
  }
}
