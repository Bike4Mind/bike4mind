import { Logger } from '@bike4mind/observability';
/**
 * Integration helpers for Conversation Context
 *
 * These functions are designed to be called from ChatCompletionProcess
 * to extract entities from tool results and inject context into system prompts.
 */

import { IConversationContext } from '@bike4mind/common';
import { extractEntities } from './extractors';
import { addEntities } from './addEntity';
import { get } from './get';
import { buildContextPrompt, hasContext } from './promptBuilder';
import { MinimalSessionRepository } from './types';

/**
 * Extract entities from an MCP tool result and save them to the session context.
 *
 * Call this from the wrappedToolFn in ChatCompletionProcess after getting the tool result.
 *
 * @param sessionId - The session ID
 * @param toolName - The name of the tool that returned the result
 * @param toolResult - The tool result (typically a JSON string)
 * @param sessionRepo - The sessions repository
 * @returns The updated context, or null if no entities were extracted
 *
 * @example
 * ```ts
 * // In wrappedToolFn:
 * const result = await originalToolFn(args);
 *
 * // Extract entities from tool result
 * await extractAndSaveEntitiesFromToolResult(
 *   sessionId,
 *   name,
 *   result,
 *   this.db.sessions
 * );
 *
 * return result;
 * ```
 */
export async function extractAndSaveEntitiesFromToolResult(
  sessionId: string,
  toolName: string,
  toolResult: unknown,
  sessionRepo: MinimalSessionRepository
): Promise<IConversationContext | null> {
  const resultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

  const { entities } = extractEntities(resultText, 'tool_result');

  if (entities.length === 0) {
    return null;
  }

  try {
    const context = await addEntities(sessionId, entities, { db: { sessions: sessionRepo } });
    return context;
  } catch (error) {
    // Log but don't throw - context extraction is non-critical
    Logger.globalInstance.error(`[ConversationContext] Failed to save entities from tool ${toolName}:`, error);
    return null;
  }
}

/**
 * Extract entities from a user message and save them to the session context.
 *
 * Call this when processing the user's message before sending to the LLM.
 *
 * @param sessionId - The session ID
 * @param message - The user's message
 * @param sessionRepo - The sessions repository
 * @returns The updated context, or null if no entities were extracted
 *
 * @example
 * ```ts
 * // Before building the LLM request:
 * await extractAndSaveEntitiesFromUserMessage(
 *   sessionId,
 *   message,
 *   this.db.sessions
 * );
 * ```
 */
export async function extractAndSaveEntitiesFromUserMessage(
  sessionId: string,
  message: string,
  sessionRepo: MinimalSessionRepository
): Promise<IConversationContext | null> {
  const { entities } = extractEntities(message, 'user');

  if (entities.length === 0) {
    return null;
  }

  try {
    const context = await addEntities(sessionId, entities, { db: { sessions: sessionRepo } });
    return context;
  } catch (error) {
    // Log but don't throw - context extraction is non-critical
    Logger.globalInstance.error('[ConversationContext] Failed to save entities from user message:', error);
    return null;
  }
}

/**
 * Get the conversation context system message to inject into the LLM messages.
 *
 * Call this after building the mcpGuidanceMessage in ChatCompletionProcess.
 * Returns null if there's no meaningful context to inject.
 *
 * @param sessionId - The session ID
 * @param sessionRepo - The sessions repository
 * @returns The system message to inject, or null if no context available
 *
 * @example
 * ```ts
 * // After adding mcpGuidanceMessage:
 * const contextMessage = await getConversationContextSystemMessage(
 *   sessionId,
 *   this.db.sessions
 * );
 * if (contextMessage) {
 *   messages.unshift(contextMessage);
 * }
 * ```
 */
export async function getConversationContextSystemMessage(
  sessionId: string,
  sessionRepo: MinimalSessionRepository
): Promise<{ role: 'system'; content: string } | null> {
  try {
    const context = await get(sessionId, { db: { sessions: sessionRepo } });

    if (!hasContext(context)) {
      return null;
    }

    const promptContent = buildContextPrompt(context);

    if (!promptContent) {
      return null;
    }

    return {
      role: 'system' as const,
      content: promptContent,
    };
  } catch (error) {
    // Log but don't throw - context injection is non-critical
    Logger.globalInstance.error('[ConversationContext] Failed to build context system message:', error);
    return null;
  }
}

/**
 * Check if entity extraction should run for a given tool.
 * Some tools don't produce useful entities (e.g., pure compute tools).
 *
 * @param toolName - The name of the tool
 * @returns True if entities should be extracted from this tool's results
 */
export function shouldExtractEntitiesFromTool(toolName: string): boolean {
  // Tools that are likely to return entity information
  const entityProducingToolPrefixes = [
    'github__',
    'jira_',
    'confluence_',
    'list_',
    'get_',
    'search_',
    'create_',
    'update_',
  ];

  // Tools that definitely won't produce useful entities
  const nonEntityTools = [
    'web_search',
    'web_fetch',
    'code_execution',
    'image_generation',
    'edit_image',
    'speech_to_text',
    'text_to_speech',
  ];

  if (nonEntityTools.includes(toolName)) {
    return false;
  }

  return entityProducingToolPrefixes.some(prefix => toolName.startsWith(prefix));
}
