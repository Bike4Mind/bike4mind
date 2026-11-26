import { assignPersonas } from './agentPersona';
import { DEFAULT_NOTIFY_SCOPE, type NotifyScope } from './attention';
import { deriveTaskAgentState } from './agentState';
import type { ChatMessage, ChatSessionStatus, ChatSessionSummary, ChatToolCall } from './chat';
import { descendantsOf } from './spawnTree';
import { describeToolInput } from './toolDetail';

/*
 * The needs-you rules, shared by the renderer (which announces while a window is open) and main
 * (which announces when none is; see main/attention/needsYouMonitor.ts). Both must say the same thing.
 */

/** Tool calls parked at the approval gate; shared with the peek drawer, which answers them. */
export function pendingCallsIn(messages: readonly ChatMessage[]): ChatToolCall[] {
  return messages.flatMap(message =>
    (message.toolCalls ?? []).filter(call => call.status === 'awaiting-approval' && call.approvalId)
  );
}

/** Sessions that are in needs-action now and were not before: one notice each per entry. */
export function enteredNeedsYou(
  previous: ReadonlyMap<string, ChatSessionStatus>,
  next: ReadonlyMap<string, ChatSessionStatus>
): string[] {
  return [...next]
    .filter(([id, status]) => status === 'needs-action' && previous.get(id) !== 'needs-action')
    .map(([id]) => id);
}

/**
 * Sessions whose needs-you entries alert: a parent with agents, and every agent its stage shows.
 * With the `all` scope every other session alerts too; with `agents` (the default) plain sessions
 * stay quiet. Archived sessions and anything under an archived one never alert, by the same rule
 * the roster hides them with.
 */
export function alertableSessions(
  sessions: readonly ChatSessionSummary[],
  scope: NotifyScope = DEFAULT_NOTIFY_SCOPE
): ReadonlySet<string> {
  const alertable = new Set(agentTreeSessions(sessions));
  if (scope === 'all') {
    const byId = new Map(sessions.map(session => [session.id, session]));
    for (const session of sessions) if (!underArchived(byId, session.id)) alertable.add(session.id);
  }
  return alertable;
}

/** Sessions in an orchestration: a parent with agents, and every agent its stage shows. */
function agentTreeSessions(sessions: readonly ChatSessionSummary[]): ReadonlySet<string> {
  const archived = new Set(sessions.filter(session => session.archived).map(session => session.id));
  const roots = new Set(sessions.filter(session => session.origin).map(session => rootSessionOf(sessions, session.id)));
  const inTree = new Set<string>();
  for (const root of roots) {
    if (archived.has(root)) continue;
    const agents = descendantsOf(sessions, root).map(({ session }) => session.id);
    if (agents.length === 0) continue;
    inTree.add(root);
    for (const id of agents) inTree.add(id);
  }
  return inTree;
}

/** `sessionId` or any session above it in its spawn chain is archived. */
function underArchived(byId: ReadonlyMap<string, ChatSessionSummary>, sessionId: string): boolean {
  const visited = new Set<string>();
  let current = byId.get(sessionId);
  while (current && !visited.has(current.id)) {
    if (current.archived) return true;
    visited.add(current.id);
    const parentId = current.origin?.parentSessionId;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return false;
}

/**
 * Alertable sessions waiting on the user, by deriveTaskAgentState's rule: a live approval or question,
 * or a worker task waiting on a decision. Deleted sessions are not listed, so they never count.
 */
export function needsYouCount(
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  sessions: readonly ChatSessionSummary[],
  scope: NotifyScope = DEFAULT_NOTIFY_SCOPE
): number {
  const alertable = alertableSessions(sessions, scope);
  return sessions.filter(
    session => alertable.has(session.id) && deriveTaskAgentState(session, statuses.get(session.id)) === 'needs-you'
  ).length;
}

/**
 * The dock badge: every session waiting on the user, whatever the notify scope. The scope decides
 * who may interrupt (notices, the chime); the badge answers whether anything is waiting at all, so a
 * plain session parked on an approval must show on it too. Archived and deleted sessions still never count.
 */
export function needsYouBadgeCount(
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  sessions: readonly ChatSessionSummary[]
): number {
  return needsYouCount(statuses, sessions, 'all');
}

/** The top of `sessionId`'s spawn chain among the listed sessions; itself when it was not spawned. */
export function rootSessionOf(sessions: readonly ChatSessionSummary[], sessionId: string): string {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const visited = new Set<string>();
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    const parentId = byId.get(current)?.origin?.parentSessionId;
    if (!parentId || !byId.has(parentId)) return current;
    current = parentId;
  }
  return current;
}

/** "<name> needs you", naming an agent by the persona the Tavern gives it under `rootId`. */
export function needsYouTitle(sessions: readonly ChatSessionSummary[], sessionId: string, rootId: string): string {
  const session = sessions.find(candidate => candidate.id === sessionId);
  if (!session) return 'A session needs you';
  if (sessionId !== rootId) {
    // The same subjects the roster hands the Tavern, so the notice and the stage agree on the name.
    const agents = descendantsOf(sessions, rootId).map(({ session: agent }) => ({
      id: agent.id,
      createdAt: agent.createdAt,
      title: agent.title.trim() || 'Untitled agent',
      seedPrompt: agent.origin.seedPrompt,
    }));
    const persona = assignPersonas(agents).get(sessionId);
    if (persona) return `${persona.label} needs you`;
  }
  return `${session.title.trim() || 'Untitled session'} needs you`;
}

/** What the session is waiting on: its request parked at the approval gate, as the Tavern labels it. */
export function needsYouBody(messages: readonly ChatMessage[]): string {
  const call = pendingCallsIn(messages).at(-1);
  if (!call) return 'Waiting for your answer';
  return `${call.name} ${describeToolInput(call)}`.trim();
}
