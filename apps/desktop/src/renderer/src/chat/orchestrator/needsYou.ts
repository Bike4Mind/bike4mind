import type { ChatMessage, ChatSessionStatus, ChatSessionSummary, ChatToolCall } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { activityLabel, describeToolInput, type AgentActivity } from './activity';
import { buildRoster, descendantIds } from './roster';
import { assignPersonas } from './tavern/agentPersona';

const NO_ACTIVITY: ReadonlyMap<string, AgentActivity> = new Map();
const NO_PRS: ReadonlyMap<string, PrSummary> = new Map();

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
 * Plain sessions stay quiet (the alerts and the chime setting are about agents), and so do archived
 * ones and anything under an archived agent, by the same rule the roster hides them with.
 */
export function alertableSessions(sessions: readonly ChatSessionSummary[]): ReadonlySet<string> {
  const archived = new Set(sessions.filter(session => session.archived).map(session => session.id));
  const roots = new Set(sessions.filter(session => session.origin).map(session => rootSessionOf(sessions, session.id)));
  const alertable = new Set<string>();
  for (const root of roots) {
    if (archived.has(root)) continue;
    const agents = descendantIds(sessions, root);
    if (agents.size === 0) continue;
    alertable.add(root);
    for (const id of agents) alertable.add(id);
  }
  return alertable;
}

/** Alertable sessions waiting on the user; deleted ones are not listed, so they never count. */
export function needsYouCount(
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  sessions: readonly ChatSessionSummary[]
): number {
  const alertable = alertableSessions(sessions);
  let count = 0;
  for (const [sessionId, status] of statuses) if (status === 'needs-action' && alertable.has(sessionId)) count += 1;
  return count;
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
export function needsYouTitle(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  sessionId: string,
  rootId: string
): string {
  const session = sessions.find(candidate => candidate.id === sessionId);
  if (!session) return 'A session needs you';
  if (sessionId !== rootId) {
    const roster = buildRoster({ sessions, statuses, activity: NO_ACTIVITY, prSummaries: NO_PRS, rootId });
    const persona = assignPersonas(roster).get(sessionId);
    if (persona) return `${persona.label} needs you`;
  }
  return `${session.title.trim() || 'Untitled session'} needs you`;
}

/** What the session is waiting on: its request parked at the approval gate, as the Tavern labels it. */
export function needsYouBody(messages: readonly ChatMessage[]): string {
  const call = pendingCallsIn(messages).at(-1);
  if (!call) return 'Waiting for your answer';
  return activityLabel({ kind: 'tool', tool: call.name, detail: describeToolInput(call) });
}
