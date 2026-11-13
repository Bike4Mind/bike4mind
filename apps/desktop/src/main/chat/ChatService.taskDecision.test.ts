import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inheritancePolicy,
  type PendingTaskDecision,
  type TaskContract,
  type TaskDecisionAnswer,
} from '@shared/orchestration';
import type { ChatModelOption, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import type { ModelCatalog } from './ModelCatalog';
import type { AccessStore } from './tools/AccessStore';

const contractFor = (outcome: string): TaskContract => ({
  version: 1,
  outcome,
  rationale: 'Keep scope bounded',
  role: 'implementation',
  paths: ['src/feature.ts'],
  contextReferences: [],
  ownedChanges: ['src/feature.ts'],
  coordinationConstraints: [],
  nonGoals: [],
  acceptanceCriteria: ['Focused test passes'],
  verification: ['pnpm test feature'],
  assumptions: [],
  escalationConditions: [],
});
const ASKING = 'Build the stacked feature';
const SIBLING = 'Build the sibling feature';
const decisionReport = {
  status: 'blocked',
  reason: 'The prerequisite branch has not merged',
  evidence: ['The prerequisite PR is still open'],
  decision: {
    question: 'Stack this task on the prerequisite branch, or wait until it merges?',
    options: [
      { label: 'Stack on it', description: 'Start now on top of the open branch.' },
      { label: 'Wait for the merge', description: 'Pause until it lands on main.' },
    ],
  },
};

const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
type Wire = { model: string; messages: { role: string; content: unknown }[] };

describe('a worker decision that only the user can make', () => {
  let store: SessionStore;
  let service: ChatService;
  let project: string;
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let activity: SessionActivity;
  let decisionPushes: PendingTaskDecision[][];
  const models: ChatModelOption[] = [
    { id: 'planner', name: 'Planner', supportsTools: true },
    { id: 'worker', name: 'Worker', supportsTools: true },
  ];

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-decision-project-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-decision-store-')), 'planner');
    activity = new SessionActivity(() => undefined);
    decisionPushes = [];
    const opened: PassThrough[] = [];
    streams = opened;
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const boundPost = post;
    service = new ChatService({
      store,
      activity,
      queue: new MessageQueue(() => undefined),
      taskDecisionsChanged: list => decisionPushes.push(list),
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models }), cached: () => models } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: (_event: ChatStreamEvent) => undefined,
    });
    await service.setRolePolicy({
      ...inheritancePolicy(),
      roles: { implementation: 'worker', exploration: 'inherit', review: 'inherit' },
    });
  });
  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  const wire = (index: number) => post.mock.calls[index][1] as Wire;
  const wireText = (index: number) => JSON.stringify(wire(index).messages);
  /** The newest request whose prompt mentions `text`, once there is one past `after`. */
  async function nextStream(text: string, after = -1, model?: string): Promise<number> {
    let found = -1;
    await vi.waitUntil(
      () => {
        found = post.mock.calls.findLastIndex(
          (_call, index) => index > after && (!model || wire(index).model === model) && wireText(index).includes(text)
        );
        return found >= 0;
      },
      { timeout: 5000, interval: 5 }
    );
    return found;
  }
  function tool(index: number, name: string, input: unknown) {
    streams[index].write(
      frame({ type: 'tool_use', tools: [{ id: `${name}-${index}`, name, arguments: JSON.stringify(input) }] })
    );
    streams[index].write(frame('[DONE]'));
  }
  function finish(index: number, text = 'Finished') {
    streams[index].write(frame({ type: 'content', text }));
    streams[index].write(frame('[DONE]'));
  }
  async function idle(id: string) {
    await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 5000, interval: 5 });
  }
  const plannerCalls = () => post.mock.calls.filter((_call, index) => wire(index).model === 'planner').length;

  /** An Orchestrate root with two structured workers, both mid-turn. */
  async function twoWorkers() {
    const root = await store.create('planner', {
      title: 'Root',
      mode: 'code',
      project: {
        directory: project,
        workingDirectory: project,
        name: 'Project',
        branch: '',
        workspace: false,
        contextDirectories: [],
      },
    });
    await service.setSessionOrchestrate(root.id, true);
    await service.send(root.id, 'Plan both features');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [ASKING, SIBLING].map((outcome, index) => ({
          id: `spawn-${index}`,
          name: 'session_spawn',
          arguments: JSON.stringify({ prompt: outcome, title: outcome, contract: contractFor(outcome) }),
        })),
      })
    );
    streams[0].write(frame('[DONE]'));
    const asking = await nextStream(ASKING, -1, 'worker');
    const sibling = await nextStream(SIBLING, -1, 'worker');
    finish(await nextStream('spawn-1', 0, 'planner'), 'Both started');
    await idle(root.id);
    const children = (await store.list()).filter(session => session.origin?.parentSessionId === root.id);
    const child = (outcome: string) => children.find(session => session.workerTask?.contract.outcome === outcome)!;
    return { root, asker: child(ASKING), sibling: child(SIBLING), askingStream: asking, siblingStream: sibling };
  }

  /** The asking worker reports its decision and ends its turn; the sibling is still running. */
  async function ask() {
    const setup = await twoWorkers();
    const before = plannerCalls();
    tool(setup.askingStream, 'task_report', { report: decisionReport });
    const followUp = await nextStream('End your turn now', setup.askingStream);
    finish(followUp, 'Waiting on the user.');
    await idle(setup.asker.id);
    await vi.waitUntil(() => decisionPushes.at(-1)?.length === 1, { timeout: 5000, interval: 5 });
    return { ...setup, before, decision: decisionPushes.at(-1)![0] };
  }

  const stored = async (id: string) => (await store.get(id))!;

  it('surfaces the question in the root at once while a sibling is still running', async () => {
    const { root, asker, sibling, siblingStream, before, decision } = await ask();

    expect(service.isSessionBusy(sibling.id)).toBe(true);
    expect(decision).toMatchObject({ sessionId: asker.id, rootId: root.id, title: ASKING });
    expect(decision.decision.question.options.map(option => option.label)).toEqual([
      'Stack on it (Recommended)',
      'Wait for the merge',
    ]);
    expect(await service.listTaskDecisions()).toEqual([decision]);
    expect(activity.statusOf(asker.id)).toBe('needs-action');
    // The decision is the user's, so the parent hears nothing until it is answered or skipped.
    expect((await stored(root.id)).messages.some(message => String(message.content).includes(ASKING))).toBe(false);

    finish(siblingStream, 'Sibling done');
    await idle(sibling.id);
    await vi.waitUntil(async () => (await stored(root.id)).messages.some(m => String(m.content).includes(SIBLING)), {
      timeout: 5000,
    });
    // A sibling settling does not wake the root while the asking worker waits on the user.
    expect(plannerCalls()).toBe(before);
    expect(activity.statusOf(asker.id)).toBe('needs-action');
  });

  it('resumes the same task with the answer recorded, and a stale or second answer never resumes twice', async () => {
    const { asker, decision } = await ask();
    const answer: TaskDecisionAnswer = { status: 'answered', answers: [{ selected: ['Wait for the merge'] }] };

    await Promise.all([
      service.answerTaskDecision(asker.id, decision.decision.id, answer),
      service.answerTaskDecision(asker.id, decision.decision.id, answer),
    ]);
    const resumed = await nextStream('The user answered your decision');
    expect(wireText(resumed)).toContain('Wait for the merge');

    const task = (await stored(asker.id)).workerTask!;
    expect(task.state).toEqual({ status: 'running' });
    expect(task.resolvedDecisions).toContain(decision.decision.id);
    expect(task.decisions).toEqual([
      expect.objectContaining({ id: decision.decision.id, outcome: 'answered', answer: '"Wait for the merge"' }),
    ]);
    expect(decisionPushes.at(-1)).toEqual([]);
    expect(await service.listTaskDecisions()).toEqual([]);
    expect(activity.statusOf(asker.id)).toBe('processing');

    const resumes = () =>
      post.mock.calls.filter((_call, index) => wireText(index).includes('The user answered')).length;
    await service.answerTaskDecision(asker.id, decision.decision.id, answer);
    expect(resumes()).toBe(1);
    finish(resumed);
    await idle(asker.id);
  });

  it('wakes the root once the resumed worker settles, with the sibling that finished meanwhile', async () => {
    const { asker, sibling, siblingStream, decision, before } = await ask();
    finish(siblingStream, 'Sibling done');
    await idle(sibling.id);
    expect(plannerCalls()).toBe(before);

    await service.answerTaskDecision(asker.id, decision.decision.id, {
      status: 'answered',
      answers: [{ selected: ['Stack on it (Recommended)'] }],
    });
    finish(await nextStream('The user answered your decision'), 'Stacked it.');
    const wake = await nextStream('Stacked it.', -1, 'planner');
    expect(wireText(wake)).toContain(SIBLING);
    finish(wake);
  });

  it('keeps the task blocked on Skip, records why, and reports it to the parent', async () => {
    const { root, asker, decision } = await ask();

    await service.answerTaskDecision(asker.id, decision.decision.id, { status: 'skipped' });

    const task = (await stored(asker.id)).workerTask!;
    expect(task.state).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('The user skipped the decision'),
      evidence: decisionReport.evidence,
    });
    expect(task.state).not.toHaveProperty('decision');
    expect(task.decisions).toEqual([expect.objectContaining({ outcome: 'skipped' })]);
    expect(post.mock.calls.some((_call, index) => wireText(index).includes('The user answered'))).toBe(false);
    expect(activity.statusOf(asker.id)).toBe('done');
    await vi.waitUntil(
      async () => (await stored(root.id)).messages.some(m => String(m.content).includes('The user skipped')),
      { timeout: 5000 }
    );
    await expect(
      service.answerTaskDecision(asker.id, decision.decision.id, { status: 'skipped' })
    ).resolves.toBeUndefined();
  });

  it('drops the card when the user types in the worker instead', async () => {
    const { asker } = await ask();
    await service.send(asker.id, 'Wait for the merge, then continue.');
    const typed = await nextStream('Wait for the merge, then continue.');
    expect(decisionPushes.at(-1)).toEqual([]);
    finish(typed);
    await idle(asker.id);
  });

  it('rebuilds pending decisions from the store after a restart', async () => {
    const { asker, decision } = await ask();
    const restarted = new ChatService({
      store,
      activity: new SessionActivity(() => undefined),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
    });
    try {
      expect(await restarted.listTaskDecisions()).toEqual([decision]);
      const summary: ChatSessionSummary | undefined = (await store.list()).find(session => session.id === asker.id);
      expect(summary?.workerTask?.state.status).toBe('blocked');
    } finally {
      restarted.dispose();
    }
  });
});
