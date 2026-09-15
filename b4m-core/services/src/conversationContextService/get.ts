import { IConversationContext } from '@bike4mind/common';
import { ConversationContextAdapters } from './types';

/**
 * Get the conversation context for a session
 *
 * @param sessionId - The session ID
 * @param adapters - Database adapters
 * @returns The conversation context or null if not found
 */
export async function get(
  sessionId: string,
  adapters: ConversationContextAdapters
): Promise<IConversationContext | null> {
  const { db } = adapters;

  const session = await db.sessions.findById(sessionId);
  if (!session) {
    return null;
  }

  return session.conversationContext || null;
}

/**
 * Get the conversation context for a session, creating an empty one if it doesn't exist
 *
 * @param sessionId - The session ID
 * @param adapters - Database adapters
 * @returns The conversation context (may be empty)
 */
export async function getOrCreate(
  sessionId: string,
  adapters: ConversationContextAdapters
): Promise<IConversationContext> {
  const context = await get(sessionId, adapters);

  if (context) {
    return context;
  }

  return {
    github: {
      repos: [],
      prs: [],
      issues: [],
    },
    jira: {
      projects: [],
      issues: [],
    },
    confluence: {
      spaces: [],
      pages: [],
    },
    lastUpdated: new Date(),
  };
}
