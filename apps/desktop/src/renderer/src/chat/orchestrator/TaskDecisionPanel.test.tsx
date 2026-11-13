// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inheritancePolicy, type TaskContract, type WorkerTask } from '@shared/orchestration';
import { TaskDecisionPanel } from './TaskDecisionPanel';
import { agentFixture, createThemedMount, el, typeInto } from './testUtils';
import { agentStates, buildRoster } from './roster';
import type { ChatSessionSummary } from '@shared/chat';

const contract: TaskContract = {
  version: 1,
  outcome: 'Focused change',
  rationale: 'Bounded work',
  role: 'implementation',
  paths: [],
  contextReferences: [],
  ownedChanges: [],
  coordinationConstraints: [],
  nonGoals: [],
  acceptanceCriteria: ['Focused behavior'],
  verification: [],
  assumptions: [],
  escalationConditions: [],
};
const task = (): WorkerTask => ({
  version: 1,
  contract,
  automaticUpgrades: 0,
  resolvedDecisions: [],
  attempts: [{ id: 'attempt-one', model: 'worker', startedAt: 'now', trigger: 'initial' }],
  state: {
    status: 'completed',
    accepted: false,
    changedPaths: [],
    verification: [{ criterion: 'Focused behavior', command: 'inspect', outcome: 'passed', evidence: 'Observed' }],
    unmetCriteria: [],
    handoff: 'Ready',
  },
});
const themed = createThemedMount();
const taskAction = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { listModels: vi.fn(async () => ({ models: [{ id: 'worker', name: 'Catalog Worker' }] })), taskAction },
  };
});
afterEach(() => themed.unmount());

it('renders effective catalog names and acceptance evidence, then sends a concrete assessment', async () => {
  const agent = agentFixture('child', 'needs-you', {
    model: 'worker',
    workerSelection: { role: 'implementation', effectiveModel: 'worker', source: 'role-policy', rootRunId: 'run' },
    workerTask: task(),
  });
  taskAction.mockResolvedValue({
    workerTask: { ...task(), state: { ...task().state, accepted: true, assessment: 'Reviewed the evidence' } },
  });
  await themed.render(<TaskDecisionPanel agent={agent} />);
  expect(el('agent-effective-model').textContent).toContain('implementation: Catalog Worker (role-policy)');
  expect(el('agent-task-state').textContent).toContain('awaiting assessment');
  expect(document.body.textContent).toContain('Focused behavior: passed');
  await typeInto(el('agent-task-note').querySelector('textarea') as HTMLTextAreaElement, 'Reviewed the evidence');
  await act(async () => el('agent-task-accept-btn').click());
  expect(taskAction).toHaveBeenLastCalledWith('child', { kind: 'accept', assessment: 'Reviewed the evidence' });
  expect(el('agent-task-state').textContent).toContain('accepted');
});

it('shows a canceled task as closed and offers no restart controls', async () => {
  const agent = agentFixture('child', 'stopped', {
    model: 'worker',
    workerTask: { ...task(), state: { status: 'canceled', reason: 'Closing out: the work is finished.' } },
  });
  await themed.render(<TaskDecisionPanel agent={agent} />);
  expect(el('agent-task-state').textContent).toContain('canceled');
  expect(el('agent-task-closed-note').textContent).toContain('You can still chat in this conversation');
  expect(document.querySelector('[data-testid="agent-task-revise-btn"]')).toBeNull();
});

it('preserves an assessment draft across an unchanged task IPC refresh', async () => {
  const agent = agentFixture('child', 'needs-you', { model: 'worker', workerTask: task() });
  await themed.render(<TaskDecisionPanel agent={agent} />);
  await typeInto(el('agent-task-note').querySelector('textarea') as HTMLTextAreaElement, 'Keep this assessment draft');
  await themed.render(
    <TaskDecisionPanel agent={{ ...agent, workerTask: JSON.parse(JSON.stringify(agent.workerTask)) as WorkerTask }} />
  );
  expect((el('agent-task-note').querySelector('textarea') as HTMLTextAreaElement).value).toBe(
    'Keep this assessment draft'
  );
});

it('shows disproven assumptions and denies an upgrade without starting another attempt', async () => {
  const pending: WorkerTask = {
    ...task(),
    state: {
      status: 'escalation-requested',
      reason: 'The shared interface differs',
      evidence: ['Observed the incompatible signature'],
      decisionId: 'decision-one',
      requestedModelId: 'premium',
    },
  };
  const agent = agentFixture('child', 'needs-you', {
    model: 'worker',
    workerTask: pending,
    orchestrationPolicy: {
      rootSessionId: 'parent',
      rootRunId: 'run',
      policy: {
        ...inheritancePolicy(),
        escalation: {
          mode: 'ask',
          allowedModels: ['premium'],
          allowedRoles: ['implementation'],
          maxAutomaticUpgrades: 0,
        },
      },
    },
  });
  taskAction.mockResolvedValue({
    workerTask: {
      ...pending,
      state: {
        status: 'blocked',
        reason: 'User declined the model upgrade.',
        evidence: pending.state.status === 'escalation-requested' ? pending.state.evidence : [],
      },
    },
  });
  await themed.render(<TaskDecisionPanel agent={agent} />);
  expect(document.body.textContent).toContain('Observed the incompatible signature');
  await act(async () => el('agent-task-deny-btn').click());
  expect(taskAction).toHaveBeenCalledTimes(1);
  expect(taskAction).toHaveBeenLastCalledWith('child', {
    kind: 'deny',
    decisionId: 'decision-one',
    reason: 'User declined the model upgrade.',
  });
  expect(el('agent-task-state').textContent).toContain('blocked');
});

it.each(['blocked', 'escalation-requested', 'completed'] as const)(
  'keeps header and stage attention in agreement for %s task evidence',
  status => {
    const state: WorkerTask['state'] =
      status === 'completed'
        ? task().state
        : status === 'blocked'
          ? { status, reason: 'Blocked', evidence: ['Missing input'] }
          : { status, reason: 'Decision needed', evidence: ['Changed interface'], decisionId: 'decision' };
    const session = {
      id: 'child',
      title: 'Child',
      model: 'worker',
      lastOutcome: 'finished',
      origin: { parentSessionId: 'root', depth: 1, seedPrompt: 'Task' },
      workerTask: { ...task(), state },
    } as ChatSessionSummary;
    const input = {
      sessions: [session],
      rootId: 'root',
      statuses: new Map(),
      activity: new Map(),
      prSummaries: new Map(),
    };
    expect(agentStates(input.sessions, input.statuses, input.rootId)).toEqual(['needs-you']);
    expect(buildRoster(input)[0].state).toBe('needs-you');
  }
);
