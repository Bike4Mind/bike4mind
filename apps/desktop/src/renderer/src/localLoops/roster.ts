import type { LocalLoopDetail } from '@shared/localLoops';
import { loopNeedsYouItems } from '@shared/needsYou';
import { AGENT_STATE_PRIORITY, type AgentView } from '../chat/orchestrator/roster';

/** Roster ids that are not chat sessions (no session to peek or open yet). */
export const isLoopSessionId = (id: string) => !/^(run|ticket|lane):/.test(id);

/**
 * A Desktop loop's lanes as orchestrator agents, so the Tavern and Table views draw them like chat sub-agents:
 * a running run is a working agent (its id the run's session, so the peek drawer and Open session work), a ticket
 * waiting on the owner is a needs-you agent, and every free lane is a resting agent carrying the loop's idle reason.
 */
export function buildLoopRoster(detail: LocalLoopDetail): AgentView[] {
  const { loop } = detail;
  const titles = new Map(detail.tickets.map(ticket => [ticket.id, ticket.title]));
  const base = { parentId: loop.id, depth: 1 };
  const views: AgentView[] = [];

  const open = detail.runs.filter(run => !run.endedAt);
  for (const run of open) {
    const title = run.ticketId ? (titles.get(run.ticketId) ?? 'Ticket') : 'Triage';
    views.push({
      ...base,
      id: run.sessionId ?? `run:${run.id}`,
      title,
      seedPrompt: title,
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
      model: run.model,
      credits: run.credits,
      state: 'working',
    });
  }

  for (const item of loopNeedsYouItems(detail)) {
    if (!item.ticketId) continue;
    // runs are newest first: the ticket's latest session holds the question.
    const run = detail.runs.find(entry => entry.ticketId === item.ticketId && entry.sessionId);
    const ticket = detail.tickets.find(entry => entry.id === item.ticketId);
    views.push({
      ...base,
      id: run?.sessionId ?? `ticket:${item.ticketId}`,
      title: item.title,
      seedPrompt: item.title,
      createdAt: ticket?.createdAt ?? '',
      updatedAt: ticket?.updatedAt ?? '',
      model: run?.model ?? loop.model,
      state: 'needs-you',
      lastSnippet: item.reason,
    });
  }

  for (let lane = open.length + 1; lane <= loop.maxConcurrent; lane += 1) {
    views.push({
      ...base,
      id: `lane:${loop.id}:${lane}`,
      title: `Lane ${lane}`,
      seedPrompt: '',
      createdAt: loop.createdAt,
      updatedAt: loop.updatedAt,
      model: loop.model,
      state: 'idle',
      ...(detail.idleReason && { lastSnippet: detail.idleReason }),
    });
  }

  return views.sort((a, b) => AGENT_STATE_PRIORITY.indexOf(a.state) - AGENT_STATE_PRIORITY.indexOf(b.state));
}
