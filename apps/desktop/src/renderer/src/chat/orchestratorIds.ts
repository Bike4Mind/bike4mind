import { orchestratesAgents, type ChatSessionSummary } from '@shared/chat';

/**
 * Sessions the sidebar marks as orchestrators: Orchestrate is in effect (orchestratesAgents), or a session
 * they spawned carries a worker task. Main only accepts a task contract from an orchestrating parent
 * (ChatService spawn), so a worker child still identifies its orchestrator once the launch-scoped
 * `orchestrate` flag has lapsed. A session that spawned only plain free-text children is not one.
 */
export function orchestratorIds(
  sessions: readonly Pick<ChatSessionSummary, 'id' | 'orchestrate' | 'origin' | 'workerTask'>[]
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (orchestratesAgents(session)) ids.add(session.id);
    if (session.workerTask && session.origin) ids.add(session.origin.parentSessionId);
  }
  return ids;
}
