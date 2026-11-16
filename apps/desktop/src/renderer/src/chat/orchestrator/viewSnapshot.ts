import { VIEW_SNAPSHOT_CONTRACT, type ViewAgent, type ViewSnapshot } from '@shared/viewSnapshot';
import { agentNowText } from './activity';
import type { AgentView, ParentView } from './roster';

function rootState(parent: ParentView): ViewSnapshot['root']['state'] {
  if (parent.status === 'needs-action') return 'needs-you';
  if (parent.status === 'processing') return 'working';
  return 'idle';
}

function toViewAgent(agent: AgentView): ViewAgent {
  const now = agentNowText(agent);
  return {
    id: agent.id,
    title: agent.title,
    state: agent.state,
    parentId: agent.parentId,
    depth: agent.depth,
    updatedAt: agent.updatedAt,
    ...(now && { now }),
    ...(agent.decision &&
      agent.state === 'needs-you' && {
        decision: { id: agent.decision.id, question: agent.decision.question.question },
      }),
    ...(agent.pr && { pr: { number: agent.pr.number, state: agent.pr.state } }),
    ...(agent.usdCost !== undefined && { usdCost: agent.usdCost }),
    ...(agent.credits !== undefined && { credits: agent.credits }),
  };
}

/** The roster as a view sees it (@shared/viewSnapshot). `agents` keeps the roster's urgency order. */
export function toViewSnapshot(rootId: string, agents: readonly AgentView[], parent: ParentView): ViewSnapshot {
  return {
    contract: VIEW_SNAPSHOT_CONTRACT,
    root: { id: rootId, state: rootState(parent) },
    agents: agents.map(toViewAgent),
  };
}
