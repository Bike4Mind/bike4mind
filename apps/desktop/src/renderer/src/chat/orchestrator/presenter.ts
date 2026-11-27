import type { PendingDecision } from '@shared/orchestration';
import type { ViewAction, ViewApproval } from '@shared/viewSnapshot';
import type { InnkeeperDesk } from './OrchestratorStage';
import type { AgentView, ParentView } from './roster';
import { isOneClickDecision } from './scene/bubbleAnswer';

/*
 * Presenter mode: the Orchestrate stage with every word that came from the work itself replaced, so the
 * surface can be screen-shared. OrchestratorStage applies redactForPresenter once, to the roster, the
 * parent, the quick approvals and the desk, before any of it reaches a view, the snapshot
 * (viewSnapshot.ts), the header or the finale. The peek drawer and the conversation keep the real data.
 */

/** What Presenter mode does with one field: pass it through, replace it with a neutral value, or leave it out. */
export type FieldRedaction = 'keep' | 'replace' | 'drop';

/** Shown where a question's text was. */
export const PRESENTER_HIDDEN_TEXT = 'Hidden while presenting';

export const presenterAgentTitle = (number: number) => `Agent ${number}`;
export const presenterOptionLabel = (index: number) => `Option ${index + 1}`;
const presenterApprovalLabel = (index: number) => `Approval ${index + 1}`;

/**
 * Every AgentView field and what Presenter mode does with it. A field added to AgentView fails to compile
 * here until it has a decision, and presenter.views.test.tsx checks redactAgent against this table field by field.
 */
export const AGENT_FIELD_REDACTION = {
  id: 'keep',
  title: 'replace',
  parentId: 'keep',
  depth: 'keep',
  seedPrompt: 'replace',
  createdAt: 'keep',
  updatedAt: 'keep',
  model: 'keep',
  workerSelection: 'keep',
  // The task contract carries the outcome, rationale and paths in prose, and past decisions with their answers.
  workerTask: 'drop',
  decision: 'replace',
  // Decided from the real labels: placeholders would make a destructive or long choice one click.
  oneClickDecision: 'replace',
  orchestrationPolicy: 'keep',
  state: 'keep',
  preparing: 'keep',
  outcome: 'keep',
  activity: 'drop',
  lastSnippet: 'drop',
  usdCost: 'drop',
  credits: 'drop',
  plan: 'drop',
  pr: 'drop',
  branch: 'drop',
  background: 'drop',
  redacted: 'replace',
} as const satisfies Record<keyof AgentView, FieldRedaction>;

export const PARENT_FIELD_REDACTION = {
  status: 'keep',
  activity: 'drop',
} as const satisfies Record<keyof ParentView, FieldRedaction>;

export const APPROVAL_FIELD_REDACTION = {
  id: 'keep',
  sessionId: 'keep',
  label: 'replace',
} as const satisfies Record<keyof ViewApproval, FieldRedaction>;

export const DESK_FIELD_REDACTION = {
  reply: 'drop',
  onReadReply: 'keep',
  conversationHidden: 'keep',
} as const satisfies Record<keyof InnkeeperDesk, FieldRedaction>;

/** Ids and timing stay, so answering still reaches the real decision; every word is replaced, by position. */
function redactDecision(decision: PendingDecision): PendingDecision {
  const { question } = decision;
  return {
    id: decision.id,
    askedAt: decision.askedAt,
    question: {
      question: PRESENTER_HIDDEN_TEXT,
      header: PRESENTER_HIDDEN_TEXT,
      options: question.options.map((_, index) => ({ label: presenterOptionLabel(index), description: '' })),
      ...(question.multiSelect !== undefined && { multiSelect: question.multiSelect }),
    },
  };
}

function redactAgent(agent: AgentView, number: number): AgentView {
  return {
    id: agent.id,
    title: presenterAgentTitle(number),
    parentId: agent.parentId,
    depth: agent.depth,
    seedPrompt: '',
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    model: agent.model,
    ...(agent.workerSelection && { workerSelection: agent.workerSelection }),
    ...(agent.decision && {
      decision: redactDecision(agent.decision),
      oneClickDecision: isOneClickDecision(
        agent.decision.question.options.map(option => option.label),
        agent.decision.question.multiSelect
      ),
    }),
    ...(agent.orchestrationPolicy && { orchestrationPolicy: agent.orchestrationPolicy }),
    state: agent.state,
    ...(agent.preparing && { preparing: agent.preparing }),
    ...(agent.outcome && { outcome: agent.outcome }),
    redacted: true,
  };
}

function redactDesk(desk: InnkeeperDesk): InnkeeperDesk {
  return {
    onReadReply: desk.onReadReply,
    conversationHidden: desk.conversationHidden,
  };
}

/**
 * Agent numbers for Presenter mode: the ones already given stay, and agents not yet numbered take the
 * next numbers in roster order. Returns `previous` itself when nobody is new, so a caller can memo on it.
 */
export function numberAgents(
  previous: ReadonlyMap<string, number>,
  agents: readonly Pick<AgentView, 'id'>[]
): ReadonlyMap<string, number> {
  const fresh = agents.filter(agent => !previous.has(agent.id));
  if (fresh.length === 0) return previous;
  const numbers = new Map(previous);
  let next = Math.max(0, ...previous.values()) + 1;
  for (const agent of fresh) numbers.set(agent.id, next++);
  return numbers;
}

export interface PresentedStage {
  agents: readonly AgentView[];
  parent: ParentView;
  approvals: readonly ViewApproval[];
  desk?: InnkeeperDesk;
}

/**
 * The stage's data as Presenter mode shows it (the *_FIELD_REDACTION tables say what happens to each
 * field). `numbers` comes from numberAgents; an agent missing from it is numbered after the rest, so a
 * title never falls back to the real one.
 */
export function redactForPresenter(stage: PresentedStage, numbers: ReadonlyMap<string, number>): PresentedStage {
  const complete = numberAgents(numbers, stage.agents);
  return {
    agents: stage.agents.map(agent => redactAgent(agent, complete.get(agent.id) ?? 0)),
    parent: { ...(stage.parent.status && { status: stage.parent.status }) },
    approvals: stage.approvals.map((approval, index) => ({
      id: approval.id,
      sessionId: approval.sessionId,
      label: presenterApprovalLabel(index),
    })),
    ...(stage.desk && { desk: redactDesk(stage.desk) }),
  };
}

/**
 * A view's action against the presented snapshot, turned back into the same action on the real one: an
 * answer's "Option N" becomes the real option label at that position. Every other action names only ids,
 * which Presenter mode keeps. Throws when the decision is no longer the agent's pending one.
 */
export function restorePresentedAction(action: ViewAction, agents: readonly AgentView[]): ViewAction {
  if (action.kind !== 'answer' || action.answer.status === 'skipped') return action;
  const decision = agents.find(agent => agent.id === action.agentId)?.decision;
  if (decision?.id !== action.decisionId) throw new Error('That question is no longer waiting for an answer');
  const realLabels = decision.question.options.map(option => option.label);
  const shownLabels = realLabels.map((_, index) => presenterOptionLabel(index));
  const answers = action.answer.answers.map(entry => ({
    ...entry,
    selected: entry.selected.map(label => {
      const index = shownLabels.indexOf(label);
      if (index === -1) throw new Error(`"${label}" is not one of the options`);
      return realLabels[index];
    }),
  }));
  return { ...action, answer: { status: 'answered', answers } };
}
