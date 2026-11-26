// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { singlePaneLayout } from './orchestratorLayout';
import { OrchestratorStage, type InnkeeperDesk } from './OrchestratorStage';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';
import {
  presenterAgentTitle,
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
import { agentFixture, createThemedMount, el, query } from './testUtils';
import { renderOrchestratorView } from './viewRegistry';
import type { WorkerTask } from '@shared/orchestration';
import { viewSnapshotSchema, type ViewAction, type ViewAgent, type ViewApproval } from '@shared/viewSnapshot';
import { toViewSnapshot } from './viewSnapshot';

const chime = vi.hoisted(() => ({ playChime: vi.fn() }));
vi.mock('./chime', () => chime);

const SECRET = 'SECRET';

/** Every redacted kind of text on a roster: titles, activity, last replies, a question and its options, PRs, branches, costs. */
const ROSTER: AgentView[] = [
  agentFixture('asking', 'needs-you', {
    title: `${SECRET} billing refactor`,
    seedPrompt: `${SECRET} seed`,
    decision: {
      id: 'decision-1',
      askedAt: '2026-10-01T00:00:00.000Z',
      question: {
        question: `${SECRET} ship it?`,
        header: `${SECRET} header`,
        options: [
          { label: `${SECRET} yes`, description: `${SECRET} yes means` },
          { label: `${SECRET} no`, description: `${SECRET} no means` },
        ],
      },
    },
    credits: 1234,
    branch: `${SECRET}-branch-a`,
  }),
  agentFixture('busy', 'working', {
    title: `${SECRET} parser work`,
    activity: { kind: 'tool', tool: 'bash', detail: `${SECRET} command` },
    usdCost: 7.77,
    pr: { number: 4242, state: 'open' },
    branch: `${SECRET}-branch-b`,
  }),
  agentFixture('shipped', 'done', {
    title: `${SECRET} docs pass`,
    lastSnippet: `${SECRET} last reply`,
    credits: 55,
    pr: { number: 4343, state: 'merged' },
  }),
  agentFixture('broken', 'failed', { title: `${SECRET} flaky test`, lastSnippet: `${SECRET} failure` }),
];

/** Strings that would only be on screen if some real text, PR number or cost got through. */
const LEAKS = [SECRET, '4242', '4343', '1,234', '1234', '7.77', 'credit'];

const answerTaskDecision = vi.fn().mockResolvedValue(undefined);
const themed = createThemedMount();

beforeEach(() => {
  answerTaskDecision.mockClear();
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      getHeldRelays: vi.fn().mockResolvedValue([]),
      getRunSpend: vi.fn().mockResolvedValue({ status: 'unattributed' }),
      onQueueChanged: vi.fn(() => () => undefined),
      onStreamEvent: vi.fn(() => () => undefined),
      answerTaskDecision,
    },
  };
});
afterEach(() => themed.unmount());

const renderStage = (view: OrchestratorViewId, { focus = false, settled = false, agents = ROSTER } = {}) =>
  themed.render(
    <OrchestratorStage
      agents={agents}
      parent={{ status: 'processing', activity: { kind: 'tool', tool: 'bash', detail: `${SECRET} root command` } }}
      rootId="root"
      layout={singlePaneLayout(view)}
      onLayoutChange={vi.fn()}
      actions={{ open: vi.fn(), stop: vi.fn(), archive: vi.fn() }}
      introPlaying={false}
      renderView={renderOrchestratorView}
      presenter={{ on: true, onToggle: vi.fn() }}
      focus={{ on: focus, onToggle: vi.fn() }}
      ambient={{ settled, wake: vi.fn(), on: true, onToggle: vi.fn() }}
    />
  );

const expectNoLeaks = () => {
  const text = `${document.body.textContent ?? ''} ${document.body.innerHTML}`;
  for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
};

describe('Presenter mode on every view', () => {
  it.each(ORCHESTRATOR_VIEWS)('%s shows no real title, activity, PR or cost, and the badge', async view => {
    await renderStage(view);
    expect(el('orchestrator-presenting-badge').textContent).toBe('Presenting');
    expectNoLeaks();
    // The leak check alone would pass on a view that drew nothing; every agent must show as its placeholder.
    const text = `${document.body.textContent ?? ''} ${document.body.innerHTML}`;
    ROSTER.forEach((_, index) => expect(text).toContain(presenterAgentTitle(index + 1)));
  });

  it('Focus mode shows placeholders and answers with the real option', async () => {
    await renderStage('board', { focus: true });
    expectNoLeaks();
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid="orchestrator-focus-option-btn"]')];
    expect(options.map(option => option.textContent)).toEqual(['Option 1', 'Option 2']);
    await act(async () => options[1].click());
    expect(answerTaskDecision).toHaveBeenCalledWith('asking', 'decision-1', {
      status: 'answered',
      answers: [{ selected: [`${SECRET} no`] }],
    });
  });

  /** The asking agent, waiting on a choice whose real labels Focus mode must not offer one click each. */
  const askingWith = (labels: string[]): AgentView[] => {
    const [asking, ...rest] = ROSTER;
    const question = { ...asking.decision!.question, options: labels.map(label => ({ label, description: label })) };
    return [{ ...asking, decision: { ...asking.decision!, question } }, ...rest];
  };

  it.each([
    ['a destructive option', ['Keep it', 'Delete the branch']],
    ['a long option', ['Yes', 'Rewrite the whole billing module from scratch']],
  ])('Focus mode sends %s to Open instead of one-click placeholders', async (_case, labels) => {
    await renderStage('board', { focus: true, agents: askingWith(labels) });
    expect(document.querySelectorAll('[data-testid="orchestrator-focus-option-btn"]')).toHaveLength(0);
    expect(query('orchestrator-focus-open-btn')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Option 2');
    expect(answerTaskDecision).not.toHaveBeenCalled();
  });

  it('the settled stage keeps the badge and sends the request to the drawer instead of showing it', async () => {
    await renderStage('tavern', { settled: true });
    expect(query('orchestrator-presenting-badge')).not.toBeNull();
    expect(el('orchestrator-needs-you-card').textContent).toContain('Open it to answer');
    expectNoLeaks();
  });

  it('opening an agent shows its real conversation details in the peek drawer', async () => {
    await renderStage('board', { focus: true });
    const open = document.querySelector<HTMLElement>('[data-testid="orchestrator-focus-open-btn"]');
    await act(async () => open?.click());
    expect(el('orchestrator-peek-drawer-region').textContent).toContain(`${SECRET} billing refactor`);
  });
});

describe('presenter', () => {
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
    plan: { done: 1, total: 3, current: `${SECRET} current`, next: `${SECRET} next` },
    pr: { number: 4242, state: 'open', repo: `${SECRET}/repo` },
    branch: `${SECRET}-branch`,
    background: { running: 1, label: `${SECRET} command` },
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
        reply: { id: 'reply-1', snippet: `${SECRET} reply` },
        onReadReply: () => undefined,
        conversationHidden: true,
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
    plan: 'drop',
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
});
