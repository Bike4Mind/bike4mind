import {
  VIEW_SNAPSHOT_CONTRACT,
  type ViewAction,
  type ViewAgent,
  type ViewApproval,
  type ViewSnapshot,
} from '@shared/viewSnapshot';
import { hostChat } from '../../host/hostChat';
import { agentNowText } from './activity';
import type { AgentView, ParentView } from './roster';
import { isOneClickDecision } from './scene/bubbleAnswer';

function rootState(parent: ParentView): ViewSnapshot['root']['state'] {
  if (parent.status === 'needs-action') return 'needs-you';
  if (parent.status === 'processing') return 'working';
  return 'idle';
}

function toViewAgent(agent: AgentView): ViewAgent {
  const now = agentNowText(agent);
  const question = agent.decision?.question;
  return {
    id: agent.id,
    title: agent.title,
    state: agent.state,
    parentId: agent.parentId,
    depth: agent.depth,
    updatedAt: agent.updatedAt,
    ...(now && { now }),
    ...(agent.decision &&
      question &&
      agent.state === 'needs-you' && {
        decision: {
          id: agent.decision.id,
          question: question.question,
          options: question.options.map(option => option.label),
          ...(question.multiSelect && { multiSelect: true }),
          oneClick:
            agent.oneClickDecision ??
            isOneClickDecision(
              question.options.map(option => option.label),
              question.multiSelect
            ),
        },
      }),
    ...(agent.pr && {
      pr: {
        number: agent.pr.number,
        state: agent.pr.state,
        ...(agent.pr.repo && { repo: agent.pr.repo }),
        ...(agent.pr.attention && { attention: agent.pr.attention }),
        ...(agent.pr.behind && { behind: true }),
        ...(agent.pr.autoMerge && { autoMerge: true }),
        ...(agent.pr.stale && { stale: true }),
      },
    }),
    ...(agent.usdCost !== undefined && { usdCost: agent.usdCost }),
    ...(agent.credits !== undefined && { credits: agent.credits }),
    ...(agent.plan && { plan: agent.plan }),
  };
}

/**
 * The roster as a view sees it (@shared/viewSnapshot). `agents` keeps the roster's urgency order;
 * `approvals` (useQuickApprovals) are listed only for the root or an agent on the roster.
 */
export function toViewSnapshot(
  rootId: string,
  agents: readonly AgentView[],
  parent: ParentView,
  approvals: readonly ViewApproval[] = []
): ViewSnapshot {
  const listed = new Set([rootId, ...agents.map(agent => agent.id)]);
  const shown = approvals.filter(approval => listed.has(approval.sessionId));
  return {
    contract: VIEW_SNAPSHOT_CONTRACT,
    root: { id: rootId, state: rootState(parent) },
    agents: agents.map(toViewAgent),
    ...(shown.length > 0 && { approvals: shown }),
  };
}

/** What the host does for an accepted action that is not answered over IPC. */
export interface ViewActionHost {
  openAgent(agentId: string): void;
  openPr?(agentId: string): void;
  openRoot(): void;
  /** The stage's own Stop (AgentActions.stop); absent where the host has none, and the action rejects. */
  stop?(agentId: string): void | Promise<void>;
  /** The session a listed quick approval belongs to, which picks the host that answers it; absent where the host lists none. */
  sessionOfApproval?(approvalId: string): string | undefined;
}

/**
 * Carries out an action acceptViewAction let through, by the same calls the built-in controls make:
 * answerTaskDecision as the decision card does, respondToApproval as the peek drawer and the Tavern
 * bubble do, and the stage's Stop. Rejects when main refuses an answer or an approval.
 */
export async function runViewAction(action: ViewAction, host: ViewActionHost): Promise<void> {
  switch (action.kind) {
    case 'open-agent':
      return host.openAgent(action.agentId);
    case 'open-pr':
      return host.openPr?.(action.agentId);
    case 'open-root':
      return host.openRoot();
    case 'answer':
      return hostChat.answerTaskDecision(action.agentId, action.decisionId, action.answer);
    case 'approve': {
      const sessionId = host.sessionOfApproval?.(action.approvalId);
      if (!sessionId) throw new Error('Approvals are not available here');
      return hostChat.respondToApproval(sessionId, action.approvalId, { decision: action.mode });
    }
    case 'stop':
      if (!host.stop) throw new Error('Stop is not available here');
      return host.stop(action.agentId);
  }
}
