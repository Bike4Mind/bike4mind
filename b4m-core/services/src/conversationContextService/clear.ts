import { IConversationContext } from '@bike4mind/common';
import { ConversationContextAdapters } from './types';

/**
 * Clear all conversation context for a session
 *
 * @param sessionId - The session ID
 * @param adapters - Database adapters
 * @returns True if cleared successfully
 */
export async function clear(sessionId: string, adapters: ConversationContextAdapters): Promise<boolean> {
  const { db } = adapters;

  const session = await db.sessions.findById(sessionId);
  if (!session) {
    return false;
  }

  const emptyContext: IConversationContext = {
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

  await db.sessions.update({
    id: sessionId,
    conversationContext: emptyContext,
  });

  return true;
}

/**
 * Clear conversation context for a specific integration only
 *
 * @param sessionId - The session ID
 * @param integration - The integration to clear ('github' | 'jira' | 'confluence')
 * @param adapters - Database adapters
 * @returns The updated conversation context
 */
export async function clearIntegration(
  sessionId: string,
  integration: 'github' | 'jira' | 'confluence',
  adapters: ConversationContextAdapters
): Promise<IConversationContext | null> {
  const { db } = adapters;

  const session = await db.sessions.findById(sessionId);
  if (!session || !session.conversationContext) {
    return null;
  }

  const context = { ...session.conversationContext };

  switch (integration) {
    case 'github':
      context.github = { repos: [], prs: [], issues: [] };
      break;
    case 'jira':
      context.jira = { projects: [], issues: [] };
      break;
    case 'confluence':
      context.confluence = { spaces: [], pages: [] };
      break;
  }

  context.lastUpdated = new Date();

  await db.sessions.update({
    id: sessionId,
    conversationContext: context,
  });

  return context;
}
