// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { assignPersonas } from '@shared/agentPersona';
import {
  type ViewAction,
  acceptViewAction,
  VIEW_SNAPSHOT_CONTRACT,
  viewSnapshotSchema,
  type ViewApproval,
} from '@shared/viewSnapshot';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { AgentView, ParentView } from './roster';
import { snapshotView, type SnapshotViewProps } from './snapshotView';
import { agentFixture, createThemedMount, el } from './testUtils';
import { ORCHESTRATOR_VIEW_COMPONENTS } from './viewRegistry';
import { runViewAction, toViewSnapshot } from './viewSnapshot';

const themed = createThemedMount();
const onSelect = vi.fn();
const onInnkeeperSelect = vi.fn();
let seen: SnapshotViewProps | undefined;

/** Records what the host hands a snapshot view, and asks for whatever a test passes it. */
function Probe(props: SnapshotViewProps) {
  seen = props;
  return <div data-testid="probe" />;
}
const ProbeView = snapshotView(Probe, { displayName: 'ProbeView' });

const hostProps = (agents: AgentView[], parent: ParentView = {}): OrchestratorViewProps => ({
  agents,
  parent,
  rootId: 'root-1',
  onSelect,
  onInnkeeperSelect,
  selectedId: null,
  introPlaying: false,
  personas: assignPersonas(agents),
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
  seen = undefined;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

const ask = (action: unknown) => act(() => seen?.onAction(action as ViewAction));

describe('snapshotView', () => {
  it('hands the view the snapshot, display data only', async () => {
    await themed.render(<ProbeView {...hostProps([agentFixture('a', 'working', { seedPrompt: 'secret prompt' })])} />);
    expect(seen?.snapshot.root).toEqual({ id: 'root-1', state: 'idle' });
    expect(seen?.snapshot.agents.map(agent => agent.id)).toEqual(['a']);
    expect(JSON.stringify(seen?.snapshot)).not.toContain('secret prompt');
  });

  it('opens an agent the snapshot lists, and the root, and nothing else', async () => {
    await themed.render(<ProbeView {...hostProps([agentFixture('a')], { status: 'needs-action' })} />);
    expect(seen?.snapshot.root.state).toBe('needs-you');
    ask({ kind: 'open-agent', agentId: 'a' });
    expect(onSelect).toHaveBeenCalledWith('a');
    ask({ kind: 'open-root' });
    expect(onInnkeeperSelect).toHaveBeenCalledTimes(1);
    ask({ kind: 'open-agent', agentId: 'not-listed' });
    ask({ kind: 'answer', agentId: 'a', text: 'yes' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('answers a decision the snapshot lists, and logs a refusal from main', async () => {
    const answerTaskDecision = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('gone'));
    (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat: { answerTaskDecision } };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const decision = {
      id: 'd1',
      askedAt: '2026-10-01T00:00:00.000Z',
      question: { question: 'Which?', header: 'Decision', options: [{ label: 'A', description: 'A' }] },
    };
    await themed.render(<ProbeView {...hostProps([agentFixture('a', 'needs-you', { decision })])} />);
    const action = {
      kind: 'answer',
      agentId: 'a',
      decisionId: 'd1',
      answer: { status: 'answered', answers: [{ selected: ['A'] }] },
    };
    await act(async () => seen?.onAction(action as ViewAction));
    expect(answerTaskDecision).toHaveBeenCalledWith('a', 'd1', action.answer);
    expect(error).not.toHaveBeenCalled();
    await act(async () => seen?.onAction(action as ViewAction));
    expect(error).toHaveBeenCalledWith('A view action failed', expect.any(Error));
    error.mockRestore();
    delete (window as unknown as { b4m?: unknown }).b4m;
  });

  it('pauses every animation under it while the window is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await themed.render(<ProbeView {...hostProps([agentFixture('a')])} />);
    expect(el('probe').parentElement?.dataset.paused).toBe('hidden');
  });

  it.each([
    ['tile-wall', 'orchestrator-tile-a'],
    ['swimlanes', 'orchestrator-swimlanes-lane-a'],
    ['constellation', 'orchestrator-constellation-node-a'],
    ['transit', 'orchestrator-transit-agent-a'],
  ] as const)('registers %s as a snapshot view that opens agents', async (view, targetId) => {
    const View = ORCHESTRATOR_VIEW_COMPONENTS[view];
    await themed.render(<View {...hostProps([agentFixture('a', 'needs-you')])} />);
    const target = el(targetId);
    act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});

describe('viewSnapshot', () => {
  const decision: NonNullable<AgentView['decision']> = {
    id: 'd1',
    askedAt: '2026-10-01T00:00:00.000Z',
    question: {
      question: 'Which database?',
      header: 'Decision',
      options: [
        { label: 'Postgres (Recommended)', description: 'Relational' },
        { label: 'Mongo', description: 'Documents' },
      ],
    },
  };

  describe('toViewSnapshot', () => {
    it('maps every agent state and keeps the roster order', () => {
      const agents = (['needs-you', 'working', 'failed', 'stopped', 'idle', 'done'] as const).map(state =>
        agentFixture(state, state)
      );
      const snapshot = toViewSnapshot('root', agents, {});
      expect(viewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      expect(snapshot.agents.map(agent => agent.state)).toEqual([
        'needs-you',
        'working',
        'failed',
        'stopped',
        'idle',
        'done',
      ]);
    });

    it('derives the root state from its session status', () => {
      expect(toViewSnapshot('root', [], { status: 'needs-action' }).root.state).toBe('needs-you');
      expect(toViewSnapshot('root', [], { status: 'processing' }).root.state).toBe('working');
      expect(toViewSnapshot('root', [], { status: 'done' }).root.state).toBe('idle');
      expect(toViewSnapshot('root', [], {}).root.state).toBe('idle');
    });

    it('carries a pending decision only while the agent needs the user', () => {
      const waiting = toViewSnapshot('root', [agentFixture('a', 'needs-you', { decision })], {});
      expect(waiting.agents[0].decision).toEqual({
        id: 'd1',
        question: 'Which database?',
        options: ['Postgres (Recommended)', 'Mongo'],
        oneClick: true,
      });
      const multi = { ...decision, question: { ...decision.question, multiSelect: true } };
      const many = toViewSnapshot('root', [agentFixture('a', 'needs-you', { decision: multi })], {});
      expect(many.agents[0].decision?.multiSelect).toBe(true);
      const moved = toViewSnapshot('root', [agentFixture('a', 'working', { decision })], {});
      expect(moved.agents[0].decision).toBeUndefined();
    });

    it('passes display fields and leaves out prompts and models', () => {
      const agent = agentFixture('a', 'done', {
        lastSnippet: 'Opened the PR',
        pr: { number: 12, state: 'open' },
        credits: 3,
        branch: 'feat/x',
      });
      const [view] = toViewSnapshot('root', [agent], {}).agents;
      expect(view).toMatchObject({ now: 'Opened the PR', pr: { number: 12, state: 'open' }, credits: 3 });
      expect(view).not.toHaveProperty('seedPrompt');
      expect(view).not.toHaveProperty('model');
      expect(view).not.toHaveProperty('branch');
    });
  });

  it('lists quick approvals only for the root and agents on the roster', () => {
    const approvals: ViewApproval[] = [
      { id: 'p-root', sessionId: 'root', label: 'bash pnpm test' },
      { id: 'p-a', sessionId: 'a', label: 'bash ls' },
      { id: 'p-gone', sessionId: 'not-listed', label: 'bash ls' },
    ];
    const snapshot = toViewSnapshot('root', [agentFixture('a', 'needs-you')], {}, approvals);
    expect(viewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.approvals?.map(approval => approval.id)).toEqual(['p-root', 'p-a']);
    expect(toViewSnapshot('root', [], {})).not.toHaveProperty('approvals');
  });

  describe('acceptViewAction', () => {
    it('opens PRs only for listed agents with PR metadata', async () => {
      const snapshot = toViewSnapshot(
        'root',
        [agentFixture('a', 'done', { pr: { number: 42, state: 'open' } }), agentFixture('b')],
        {}
      );
      const action = { kind: 'open-pr', agentId: 'a' } as const;
      expect(acceptViewAction(snapshot, action)).toEqual(action);
      expect(acceptViewAction(snapshot, { kind: 'open-pr', agentId: 'b' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'open-pr', agentId: 'root' })).toBeUndefined();
      const openPr = vi.fn();
      await runViewAction(action, { openAgent: vi.fn(), openRoot: vi.fn(), openPr });
      expect(openPr).toHaveBeenCalledWith('a');
    });
    const snapshot = toViewSnapshot(
      'root',
      [
        agentFixture('ask', 'needs-you', { decision }),
        agentFixture('gate', 'needs-you'),
        agentFixture('busy', 'working'),
        agentFixture('over', 'done'),
        agentFixture('stale', 'working', { decision }),
      ],
      { status: 'needs-action' },
      [
        { id: 'p1', sessionId: 'gate', label: 'bash pnpm test' },
        { id: 'p-root', sessionId: 'root', label: 'bash ls' },
      ]
    );
    const answered = (selected: string[], other?: string) => ({
      status: 'answered',
      answers: [{ selected, ...(other !== undefined && { other }) }],
    });
    const answer = (value: unknown, agentId = 'ask', decisionId = 'd1') => ({
      kind: 'answer',
      agentId,
      decisionId,
      answer: value,
    });

    it('accepts opening a listed agent or the root', () => {
      expect(acceptViewAction(snapshot, { kind: 'open-agent', agentId: 'over' })).toEqual({
        kind: 'open-agent',
        agentId: 'over',
      });
      expect(acceptViewAction(snapshot, { kind: 'open-root' })).toEqual({ kind: 'open-root' });
    });

    it('accepts an option of the pending decision, typed text, or a skip', () => {
      expect(acceptViewAction(snapshot, answer(answered(['Mongo'])))).toEqual(answer(answered(['Mongo'])));
      expect(acceptViewAction(snapshot, answer(answered([], '  SQLite  ')))).toEqual(answer(answered([], 'SQLite')));
      expect(acceptViewAction(snapshot, answer({ status: 'skipped' }))).toEqual(answer({ status: 'skipped' }));
    });

    it('rejects an answer that does not fit the pending decision', () => {
      const rejected = [
        answer(answered(['Oracle'])),
        answer(answered(['Postgres'])),
        answer(answered(['Mongo', 'Postgres (Recommended)'])),
        answer(answered(['Mongo', 'Mongo'])),
        answer(answered(['Mongo'], 'and also this')),
        answer(answered([])),
        answer(answered([], '   ')),
        answer({ status: 'answered', answers: [] }),
        answer({ status: 'answered', answers: [{ selected: ['Mongo'] }, { selected: ['Mongo'] }] }),
        answer({ status: 'answered', answers: [{ selected: ['Mongo'], extra: 1 }] }),
        answer({ status: 'cancelled' }),
        { ...answer(answered(['Mongo'])), extra: true },
      ];
      for (const action of rejected) expect(acceptViewAction(snapshot, action)).toBeUndefined();
    });

    it('rejects an answer to a decision that is not pending on that agent', () => {
      expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'ask', 'd-old'))).toBeUndefined();
      expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'gate'))).toBeUndefined();
      expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'stale'))).toBeUndefined();
      expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'someone-else'))).toBeUndefined();
    });

    it('allows several picks only on a multi-select decision', () => {
      const multi = { ...decision, question: { ...decision.question, multiSelect: true } };
      const many = toViewSnapshot('root', [agentFixture('ask', 'needs-you', { decision: multi })], {});
      const both = answer(answered(['Mongo', 'Postgres (Recommended)']));
      expect(acceptViewAction(many, both)).toEqual(both);
      const withText = answer(answered(['Mongo'], 'plus Redis'));
      expect(acceptViewAction(many, withText)).toEqual(withText);
    });

    it('accepts allow once or deny on a listed quick approval', () => {
      for (const mode of ['once', 'deny'] as const) {
        expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode })).toEqual({
          kind: 'approve',
          approvalId: 'p1',
          mode,
        });
      }
      expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p-root', mode: 'once' })).toBeDefined();
    });

    it('rejects approvals that are not listed as quick, and any other mode', () => {
      expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p-full-card', mode: 'once' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode: 'always' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode: 'redirect' })).toBeUndefined();
      expect(
        acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode: 'once', value: 'x' })
      ).toBeUndefined();
      const none = toViewSnapshot('root', [agentFixture('gate', 'needs-you')], {});
      expect(acceptViewAction(none, { kind: 'approve', approvalId: 'p1', mode: 'once' })).toBeUndefined();
    });

    it('accepts Stop on a working or waiting agent only', () => {
      expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'busy' })).toEqual({ kind: 'stop', agentId: 'busy' });
      expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'ask' })).toBeDefined();
      expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'over' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'root' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'someone-else' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'busy', force: true })).toBeUndefined();
    });

    it('rejects unknown agents, unknown kinds and extra fields', () => {
      expect(acceptViewAction(snapshot, { kind: 'open-agent', agentId: 'someone-else' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'send-message', agentId: 'ask', text: 'hi' })).toBeUndefined();
      expect(acceptViewAction(snapshot, { kind: 'open-root', extra: true })).toBeUndefined();
      expect(acceptViewAction(snapshot, null)).toBeUndefined();
    });
  });

  describe('runViewAction', () => {
    const chat = { answerTaskDecision: vi.fn(async () => undefined), respondToApproval: vi.fn(async () => undefined) };
    const host = {
      openAgent: vi.fn(),
      openRoot: vi.fn(),
      stop: vi.fn(),
      sessionOfApproval: vi.fn((): string | undefined => 'agent-p'),
    };

    beforeEach(() => {
      (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
    });

    afterEach(() => {
      delete (window as unknown as { b4m?: unknown }).b4m;
      for (const mock of [...Object.values(chat), ...Object.values(host)]) mock.mockClear();
    });

    it('answers through the decision card call', async () => {
      const value = { status: 'answered' as const, answers: [{ selected: ['Mongo'] }] };
      await runViewAction({ kind: 'answer', agentId: 'ask', decisionId: 'd1', answer: value }, host);
      expect(chat.answerTaskDecision).toHaveBeenCalledWith('ask', 'd1', value);
    });

    it('approves through the approval card call, never with more than the decision', async () => {
      await runViewAction({ kind: 'approve', approvalId: 'p1', mode: 'deny' }, host);
      expect(chat.respondToApproval).toHaveBeenCalledWith('p1', { decision: 'deny' });
      expect(host.sessionOfApproval).toHaveBeenCalledWith('p1');
    });

    it('rejects an approval whose session the host cannot name', async () => {
      host.sessionOfApproval.mockReturnValueOnce(undefined);
      await expect(runViewAction({ kind: 'approve', approvalId: 'p1', mode: 'once' }, host)).rejects.toThrow(
        'Approvals are not available here'
      );
      expect(chat.respondToApproval).not.toHaveBeenCalled();
    });

    it('opens and stops through the host', async () => {
      await runViewAction({ kind: 'open-agent', agentId: 'a' }, host);
      await runViewAction({ kind: 'open-root' }, host);
      await runViewAction({ kind: 'stop', agentId: 'busy' }, host);
      expect(host.openAgent).toHaveBeenCalledWith('a');
      expect(host.openRoot).toHaveBeenCalled();
      expect(host.stop).toHaveBeenCalledWith('busy');
    });

    it('rejects a stop when the host has none', async () => {
      await expect(
        runViewAction({ kind: 'stop', agentId: 'busy' }, { openAgent: host.openAgent, openRoot: host.openRoot })
      ).rejects.toThrow('Stop is not available here');
    });

    it('passes on a refusal from main', async () => {
      chat.respondToApproval.mockRejectedValueOnce(new Error('Already answered'));
      await expect(runViewAction({ kind: 'approve', approvalId: 'p1', mode: 'once' }, host)).rejects.toThrow(
        'Already answered'
      );
    });
  });

  describe('plan in the snapshot', () => {
    it('copies an agent plan and omits it when there is none', () => {
      const plan = { done: 1, total: 3, current: 'Wire it', next: 'Test it' };
      const [withPlan, without] = toViewSnapshot(
        'root',
        [agentFixture('a', 'working', { plan }), agentFixture('b')],
        {}
      ).agents;
      expect(withPlan.plan).toEqual(plan);
      expect(without).not.toHaveProperty('plan');
    });

    it('is contract 2: strict inside plan, done never above total, contract 1 rejected', () => {
      const snapshot = (plan: unknown, contract = 2) => ({
        contract,
        root: { id: 'root', state: 'idle' },
        agents: [{ id: 'a', title: 'A', state: 'idle', parentId: 'root', depth: 1, updatedAt: '', plan }],
      });
      expect(VIEW_SNAPSHOT_CONTRACT).toBe(2);
      expect(viewSnapshotSchema.safeParse(snapshot({ done: 1, total: 2, current: 'x' })).success).toBe(true);
      expect(viewSnapshotSchema.safeParse(snapshot({ done: 1, total: 2, notes: 'x' })).success).toBe(false);
      expect(viewSnapshotSchema.safeParse(snapshot({ done: 3, total: 2 })).success).toBe(false);
      expect(viewSnapshotSchema.safeParse(snapshot({ done: 1, total: 2 }, 1)).success).toBe(false);
    });
  });
});
