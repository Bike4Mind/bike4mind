import { describe, expect, it } from 'vitest';
import type { WorkerTask } from '@shared/orchestration';
import { viewSnapshotSchema, type ViewAction, type ViewAgent, type ViewApproval } from '@shared/viewSnapshot';
import type { InnkeeperDesk } from './OrchestratorStage';
import {
  AGENT_FIELD_REDACTION,
  APPROVAL_FIELD_REDACTION,
  DESK_FIELD_REDACTION,
  PARENT_FIELD_REDACTION,
  PRESENTER_HIDDEN_TEXT,
  numberAgents,
  redactForPresenter,
  restorePresentedAction,
  type FieldRedaction,
} from './presenter';
import type { AgentView, ParentView } from './roster';
import { toViewSnapshot } from './viewSnapshot';

const SECRET = 'SECRET';

// Only its text matters here; Presenter mode drops the whole task.
const workerTask = {
  version: 1,
  contract: { outcome: `${SECRET} outcome`, rationale: `${SECRET} rationale` },
  state: { status: 'blocked' },
} as unknown as WorkerTask;

/** Every AgentView field set, so a new field fails to compile here until it is added (and then the key test fails until it has a decision). */
const FULL_AGENT: { [K in keyof Required<AgentView>]: AgentView[K] } = {
  id: 'agent-a',
  title: `${SECRET} title`,
  parentId: 'root',
  depth: 2,
  seedPrompt: `${SECRET} seed`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  model: 'worker-model',
  workerSelection: { effectiveModel: 'worker-model', source: 'role-policy', rootRunId: 'run' },
  workerTask,
  decision: {
    id: 'decision-a',
    askedAt: '2026-10-02T00:00:00.000Z',
    question: {
      question: `${SECRET} question?`,
      header: `${SECRET} header`,
      options: [
        { label: `${SECRET} yes`, description: `${SECRET} yes means` },
        { label: `${SECRET} no`, description: `${SECRET} no means` },
      ],
      multiSelect: false,
    },
  },
  orchestrationPolicy: {
    rootSessionId: 'root',
    rootRunId: 'run',
    policy: {
      version: 1,
      roles: { implementation: 'inherit', exploration: 'inherit', review: 'inherit' },
      allowedOverrides: [],
      escalation: { mode: 'ask', allowedModels: [], allowedRoles: [], maxAutomaticUpgrades: 0 },
    },
  },
  state: 'needs-you',
  preparing: 'worktree',
  outcome: 'finished',
  activity: { kind: 'tool', tool: 'bash', detail: `${SECRET} command` },
  lastSnippet: `${SECRET} snippet`,
  usdCost: 1.25,
  credits: 1234,
  pr: { number: 4242, state: 'open', repo: `${SECRET}/repo` },
  branch: `${SECRET}-branch`,
  oneClickDecision: true,
  redacted: true,
};

const FULL_PARENT: { [K in keyof Required<ParentView>]: ParentView[K] } = {
  status: 'needs-action',
  activity: { kind: 'tool', tool: 'bash', detail: `${SECRET} root command` },
};

const APPROVALS: ViewApproval[] = [
  { id: 'approval-1', sessionId: 'root', label: `bash ${SECRET} rm` },
  { id: 'approval-2', sessionId: 'agent-a', label: `edit ${SECRET} file` },
];

const sortedKeys = (value: object) => Object.keys(value).sort();
const containsSecret = (value: unknown) => JSON.stringify(value ?? null).includes(SECRET);

/** Checks one record against its table: kept fields equal, dropped ones absent, replaced ones present with no secret left. */
function expectFieldByField(table: Record<string, FieldRedaction>, realRecord: object, shownRecord: object) {
  const real = realRecord as Record<string, unknown>;
  const shown = shownRecord as Record<string, unknown>;
  for (const [field, redaction] of Object.entries(table)) {
    if (redaction === 'keep') expect(shown[field], field).toEqual(real[field]);
    else if (redaction === 'drop') expect(field in shown, field).toBe(false);
    else {
      // A replaced field is there whenever the real one is, with nothing of the real one left in it.
      if (real[field] !== undefined) expect(shown[field], field).toBeDefined();
      expect(containsSecret(shown[field]), field).toBe(false);
    }
  }
}

const presentOne = (agent: AgentView = FULL_AGENT) =>
  redactForPresenter({ agents: [agent], parent: FULL_PARENT, approvals: APPROVALS }, new Map([[agent.id, 3]]));

describe('redactForPresenter', () => {
  it('has a decision for every roster, parent and approval field', () => {
    expect(sortedKeys(AGENT_FIELD_REDACTION)).toEqual(sortedKeys(FULL_AGENT));
    expect(sortedKeys(PARENT_FIELD_REDACTION)).toEqual(sortedKeys(FULL_PARENT));
    expect(sortedKeys(APPROVAL_FIELD_REDACTION)).toEqual(sortedKeys(APPROVALS[0]));
  });

  it('keeps, replaces and drops each agent field as its table says', () => {
    const [shown] = presentOne().agents;
    expectFieldByField(AGENT_FIELD_REDACTION, FULL_AGENT, shown);
    expect(shown.title).toBe('Agent 3');
    expect(shown.seedPrompt).toBe('');
    expect(shown.redacted).toBe(true);
  });

  it('keeps the decision answerable by id while replacing every word in it', () => {
    const decision = presentOne().agents[0].decision;
    expect(decision).toEqual({
      id: 'decision-a',
      askedAt: FULL_AGENT.decision?.askedAt,
      question: {
        question: PRESENTER_HIDDEN_TEXT,
        header: PRESENTER_HIDDEN_TEXT,
        options: [
          { label: 'Option 1', description: '' },
          { label: 'Option 2', description: '' },
        ],
        multiSelect: false,
      },
    });
  });

  it.each([
    ['a safe choice', ['Keep it', 'Skip'], undefined, true],
    ['a destructive option', ['Keep it', 'Delete the branch'], undefined, false],
    ['a long option', ['Yes', 'Rewrite the whole billing module from scratch'], undefined, false],
    ['a multi-select', ['A', 'B'], true, false],
  ])('decides one-click from the real labels of %s, not the placeholders', (_case, labels, multiSelect, oneClick) => {
    const question = {
      question: 'q',
      header: 'h',
      options: labels.map(label => ({ label, description: '' })),
      multiSelect,
    };
    const agent = { ...FULL_AGENT, oneClickDecision: undefined, decision: { ...FULL_AGENT.decision!, question } };
    const [shown] = presentOne(agent).agents;
    expect(shown.oneClickDecision).toBe(oneClick);
    const snapshot = toViewSnapshot('root', [shown], FULL_PARENT);
    expect(snapshot.agents[0].decision?.oneClick).toBe(oneClick);
    expect(snapshot.agents[0].decision?.options).toEqual(labels.map((_, index) => `Option ${index + 1}`));
  });

  it('keeps the parent state, drops its activity and relabels approvals by position', () => {
    const shown = presentOne();
    expectFieldByField(PARENT_FIELD_REDACTION, FULL_PARENT, shown.parent);
    shown.approvals.forEach((approval, index) =>
      expectFieldByField(APPROVAL_FIELD_REDACTION, APPROVALS[index], approval)
    );
    expect(shown.approvals.map(approval => approval.label)).toEqual(['Approval 1', 'Approval 2']);
  });

  it("drops the desk's reply text and keeps its controls", () => {
    const desk: { [K in keyof Required<InnkeeperDesk>]: InnkeeperDesk[K] } = {
      send: () => undefined,
      reply: { id: 'reply-1', snippet: `${SECRET} reply` },
      onReadReply: () => undefined,
      onOpenConversation: () => undefined,
      conversationHidden: true,
      openRequest: { seq: 2, seed: 'h' },
    };
    expect(sortedKeys(DESK_FIELD_REDACTION)).toEqual(sortedKeys(desk));
    const shown = redactForPresenter({ agents: [], parent: {}, approvals: [], desk }, new Map()).desk;
    expect(shown).toBeDefined();
    expectFieldByField(DESK_FIELD_REDACTION, desk, shown ?? {});
  });

  it('numbers an agent missing from the map after the rest rather than showing its title', () => {
    const second = { ...FULL_AGENT, id: 'agent-b' };
    const { agents } = redactForPresenter(
      { agents: [FULL_AGENT, second], parent: {}, approvals: [] },
      new Map([['agent-a', 1]])
    );
    expect(agents.map(agent => agent.title)).toEqual(['Agent 1', 'Agent 2']);
  });
});

/** Every snapshot field and what Presenter mode leaves of it, once the snapshot is built from the redacted roster. */
const SNAPSHOT_FIELDS = {
  contract: 'keep',
  root: 'keep',
  agents: 'replace',
  approvals: 'replace',
} as const satisfies Record<keyof typeof viewSnapshotSchema.shape, FieldRedaction>;
const SNAPSHOT_ROOT_FIELDS = { id: 'keep', state: 'keep' } as const satisfies Record<
  keyof typeof viewSnapshotSchema.shape.root.shape,
  FieldRedaction
>;
const SNAPSHOT_AGENT_FIELDS = {
  id: 'keep',
  title: 'replace',
  state: 'keep',
  parentId: 'keep',
  depth: 'keep',
  updatedAt: 'keep',
  // Derived from activity and the last reply, both dropped; only a setup step's fixed label could remain.
  now: 'drop',
  decision: 'replace',
  pr: 'drop',
  usdCost: 'drop',
  credits: 'drop',
} as const satisfies Record<keyof ViewAgent, FieldRedaction>;
const SNAPSHOT_DECISION_FIELDS = {
  id: 'keep',
  question: 'replace',
  options: 'replace',
  multiSelect: 'keep',
  // Decided on the real labels before they were replaced, so it matches the real snapshot.
  oneClick: 'keep',
} as const satisfies Record<keyof NonNullable<ViewAgent['decision']>, FieldRedaction>;

describe('the snapshot built from the redacted roster', () => {
  const agentShape = viewSnapshotSchema.shape.agents.element.shape;

  it('has a decision for every field of the snapshot schema', () => {
    expect(sortedKeys(SNAPSHOT_FIELDS)).toEqual(sortedKeys(viewSnapshotSchema.shape));
    expect(sortedKeys(SNAPSHOT_ROOT_FIELDS)).toEqual(sortedKeys(viewSnapshotSchema.shape.root.shape));
    expect(sortedKeys(SNAPSHOT_AGENT_FIELDS)).toEqual(sortedKeys(agentShape));
    expect(sortedKeys(SNAPSHOT_DECISION_FIELDS)).toEqual(sortedKeys(agentShape.decision.unwrap().shape));
    expect(sortedKeys(APPROVAL_FIELD_REDACTION)).toEqual(
      sortedKeys(viewSnapshotSchema.shape.approvals.unwrap().element.shape)
    );
  });

  it('carries none of the real words, and still validates against the contract', () => {
    const working = { ...FULL_AGENT, state: 'working' as const, preparing: undefined };
    const realAgents = [FULL_AGENT, { ...working, id: 'agent-b' }];
    const real = toViewSnapshot('root', realAgents, FULL_PARENT, APPROVALS);
    const shown = redactForPresenter(
      { agents: realAgents, parent: FULL_PARENT, approvals: APPROVALS },
      numberAgents(new Map(), realAgents)
    );
    const snapshot = toViewSnapshot('root', shown.agents, shown.parent, shown.approvals);

    expect(containsSecret(real)).toBe(true);
    expect(containsSecret(snapshot)).toBe(false);
    expect(viewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expectFieldByField(SNAPSHOT_FIELDS, real, snapshot);
    expectFieldByField(SNAPSHOT_ROOT_FIELDS, real.root, snapshot.root);
    snapshot.agents.forEach((agent, index) => expectFieldByField(SNAPSHOT_AGENT_FIELDS, real.agents[index], agent));
    expectFieldByField(SNAPSHOT_DECISION_FIELDS, real.agents[0].decision ?? {}, snapshot.agents[0].decision ?? {});
    expect(snapshot.agents[0].decision?.options).toEqual(['Option 1', 'Option 2']);
  });
});

describe('numberAgents', () => {
  it('numbers in roster order and keeps each number while the roster reorders and grows', () => {
    const first = numberAgents(new Map(), [{ id: 'b' }, { id: 'a' }]);
    expect([...first]).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    const second = numberAgents(first, [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
    expect(Object.fromEntries(second)).toEqual({ b: 1, a: 2, c: 3 });
  });

  it('hands back the same map when nobody is new, and keeps the numbers of agents that left', () => {
    const numbers = numberAgents(new Map(), [{ id: 'a' }, { id: 'b' }]);
    expect(numberAgents(numbers, [{ id: 'b' }])).toBe(numbers);
    expect(numberAgents(numbers, [{ id: 'd' }]).get('d')).toBe(3);
  });
});

describe('restorePresentedAction', () => {
  const answer = (selected: string[]): ViewAction => ({
    kind: 'answer',
    agentId: 'agent-a',
    decisionId: 'decision-a',
    answer: { status: 'answered', answers: [{ selected }] },
  });

  it('turns a placeholder option back into the real label at the same position', () => {
    expect(restorePresentedAction(answer(['Option 2']), [FULL_AGENT])).toEqual(answer([`${SECRET} no`]));
  });

  it('passes a typed answer, a skip and every other action through unchanged', () => {
    const typed: ViewAction = {
      kind: 'answer',
      agentId: 'agent-a',
      decisionId: 'decision-a',
      answer: { status: 'answered', answers: [{ selected: [], other: 'my own words' }] },
    };
    const skipped: ViewAction = { ...typed, answer: { status: 'skipped' } };
    const stop: ViewAction = { kind: 'stop', agentId: 'agent-a' };
    expect(restorePresentedAction(typed, [FULL_AGENT])).toEqual(typed);
    expect(restorePresentedAction(skipped, [FULL_AGENT])).toBe(skipped);
    expect(restorePresentedAction(stop, [FULL_AGENT])).toBe(stop);
  });

  it('refuses a label that is not a placeholder, and a decision that is no longer pending', () => {
    expect(() => restorePresentedAction(answer([`${SECRET} yes`]), [FULL_AGENT])).toThrow('not one of the options');
    expect(() => restorePresentedAction(answer(['Option 1']), [{ ...FULL_AGENT, decision: undefined }])).toThrow(
      'no longer waiting'
    );
  });
});
