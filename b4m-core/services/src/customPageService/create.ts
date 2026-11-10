import {
  CUSTOM_PAGE_TOOL_NAMES,
  PAGE_SURFACE,
  type CreateCustomPageInputType,
  type ICustomPageDocument,
  type IUserDocument,
} from '@bike4mind/common';
import { createSession } from '../sessionService/create';
import { buildOrchestratorPrompt } from './orchestratorPrompt';
import type { CreateCustomPageAdapters } from './ports';

export const ORCHESTRATOR_MAX_TOOL_CALLS = 12;

/** Creates the page and its orchestrator session; the session is removed again if the page insert fails. */
export async function createPage(
  user: IUserDocument,
  input: CreateCustomPageInputType,
  adapters: CreateCustomPageAdapters
): Promise<ICustomPageDocument> {
  const session = await createSession(
    user,
    {
      name: input.name,
      surface: PAGE_SURFACE,
      systemPromptText: buildOrchestratorPrompt(input),
      enabledTools: [...CUSTOM_PAGE_TOOL_NAMES],
      disabledTools: ['navigate_view'],
      maxToolCalls: ORCHESTRATOR_MAX_TOOL_CALLS,
    },
    adapters
  );

  try {
    return await adapters.db.customPages.create({
      userId: user.id,
      name: input.name,
      icon: input.icon ?? null,
      description: input.description ?? null,
      state: {},
      widgets: [],
      orchestratorSessionId: session.id,
      version: 0,
      deletedAt: null,
    });
  } catch (error) {
    try {
      await adapters.db.sessions.delete(session.id);
    } catch (cleanupError) {
      adapters.logger?.warn('Failed to remove the orchestrator session of a page that was not created', {
        sessionId: session.id,
        error: cleanupError,
      });
    }
    throw error;
  }
}
