/**
 * Conversation Context Service
 *
 * Manages conversation context for low-effort prompt handling.
 * Tracks recently mentioned entities from GitHub, Jira, and Confluence
 * to enable reference resolution (e.g., "review that PR").
 */

export { get, getOrCreate } from './get';
export { addEntity, addEntities } from './addEntity';
export { clear, clearIntegration } from './clear';
export { buildContextPrompt, hasContext } from './promptBuilder';
export type { PromptBuilderOptions } from './promptBuilder';
export {
  extractAndSaveEntitiesFromToolResult,
  extractAndSaveEntitiesFromUserMessage,
  getConversationContextSystemMessage,
  shouldExtractEntitiesFromTool,
} from './integration';
export * from './types';
export * from './extractors';
