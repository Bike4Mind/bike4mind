import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestGraphDocument, IQuestNodeDocument } from '@bike4mind/common';

import { buildNodeQuery } from './runQuestNode';

describe('buildNodeQuery', () => {
  it('renders title and task', () => {
    expect(buildNodeQuery({ title: 'Fetch the data', task: 'Pull the last 30 days of logs.' })).toBe(
      '# Fetch the data\n\nPull the last 30 days of logs.'
    );
  });

  it('appends acceptance criteria when present', () => {
    const query = buildNodeQuery({
      title: 'Fetch the data',
      task: 'Pull the last 30 days of logs.',
      acceptanceCriteria: 'A CSV with one row per request.',
    });
    expect(query).toContain('## Acceptance criteria');
    expect(query).toContain('A CSV with one row per request.');
  });

  it('omits the acceptance-criteria section when it is blank', () => {
    const query = buildNodeQuery({ title: 'T', task: 'Do it', acceptanceCriteria: '   ' });
    expect(query).not.toContain('Acceptance criteria');
  });
});

const create = vi.fn();
const claimForRun = vi.fn();
const setExecution = vi.fn();
const updateStatus = vi.fn();
const cleanupStaleActive = vi.fn();
const countActiveByUserId = vi.fn();
const markFailed = vi.fn();
const questCreate = vi.fn();
const questUpdateOne = vi.fn();
const questDeleteOne = vi.fn();
const lambdaSend = vi.fn();
const findUnfinishedByAgentExecutionIds = vi.fn();
const settleIfUnfinished = vi.fn();

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    cleanupStaleActive: (...a: unknown[]) => cleanupStaleActive(...a),
    countActiveByUserId: (...a: unknown[]) => countActiveByUserId(...a),
    create: (...a: unknown[]) => create(...a),
    markFailed: (...a: unknown[]) => markFailed(...a),
  },
  questNodeRepository: {
    claimForRun: (...a: unknown[]) => claimForRun(...a),
    setExecution: (...a: unknown[]) => setExecution(...a),
    updateStatus: (...a: unknown[]) => updateStatus(...a),
  },
  questRepository: {
    findUnfinishedByAgentExecutionIds: (...a: unknown[]) => findUnfinishedByAgentExecutionIds(...a),
    settleIfUnfinished: (...a: unknown[]) => settleIfUnfinished(...a),
  },
  Quest: {
    create: (...a: unknown[]) => questCreate(...a),
    updateOne: (...a: unknown[]) => questUpdateOne(...a),
    deleteOne: (...a: unknown[]) => questDeleteOne(...a),
  },
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = (...a: unknown[]) => lambdaSend(...a);
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('sst', () => ({
  Resource: { lambdaFunctionNames: { agentExecutor: 'agent-executor-fn' } },
}));

const { runQuestNode } = await import('./runQuestNode');
const { ABANDONED_REPLY } = await import('@server/chatCompletion/questTimeoutRecovery');

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const node = (over: Partial<IQuestNodeDocument> = {}): IQuestNodeDocument =>
  ({
    id: 'n1',
    graphId: 'g1',
    dependsOn: [],
    order: 0,
    depth: 0,
    kind: 'task',
    title: 'Fetch the data',
    task: 'Pull the last 30 days of logs.',
    acceptanceCriteria: '',
    status: 'pending',
    enabledTools: [],
    artifactIds: [],
    ...over,
  }) as IQuestNodeDocument;

const graph = (over: Partial<IQuestGraphDocument> = {}): IQuestGraphDocument =>
  ({ id: 'g1', sessionId: 's1', ...over }) as IQuestGraphDocument;

describe('runQuestNode memory gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupStaleActive.mockResolvedValue([]);
    countActiveByUserId.mockResolvedValue(0);
    claimForRun.mockResolvedValue(node({ status: 'in_progress' }));
    questCreate.mockResolvedValue({ id: 'q1' });
    create.mockResolvedValue({ id: 'exec-1' });
    questUpdateOne.mockResolvedValue(undefined);
    setExecution.mockResolvedValue(node({ status: 'in_progress', execution: { agentExecutionId: 'exec-1' } }));
    lambdaSend.mockResolvedValue(undefined);
  });

  // The load-bearing assertion for #1523: a V5 node execution must be stamped
  // enableMementos: false at creation. It is genuinely top-level (no lineage
  // guard fires) and carries no per-request opt-out, so this explicit false is
  // the only thing that makes resolveExecutionMementoGates short-circuit both
  // the read and write memory pipelines for the machine-generated node query.
  it('stamps enableMementos: false on the execution it creates', async () => {
    await runQuestNode({ node: node(), graph: graph(), userId: 'u1', model: 'gpt-x', logger });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ enableMementos: false });
  });

  it('never leaves enableMementos undefined (which a V2-opted user would read as memory-on)', async () => {
    await runQuestNode({ node: node(), graph: graph(), userId: 'u1', model: 'gpt-x', logger });

    expect(create.mock.calls[0][0].enableMementos).toBe(false);
  });
});

describe('runQuestNode stale sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupStaleActive.mockResolvedValue([]);
    countActiveByUserId.mockResolvedValue(0);
    claimForRun.mockResolvedValue(node({ status: 'in_progress' }));
    questCreate.mockResolvedValue({ id: 'q1' });
    create.mockResolvedValue({ id: 'exec-1' });
    questUpdateOne.mockResolvedValue(undefined);
    setExecution.mockResolvedValue(node({ status: 'in_progress', execution: { agentExecutionId: 'exec-1' } }));
    lambdaSend.mockResolvedValue(undefined);
    findUnfinishedByAgentExecutionIds.mockResolvedValue([]);
    settleIfUnfinished.mockResolvedValue(true);
  });

  // Guards the wiring, not the helper. The sweep writes `aborted`, which is
  // terminal, so the hourly cron can never revisit these executions: if this
  // dispatch path stops settling, the bubbles it strands spin forever and
  // nothing else in the system can reach them.
  it('settles the bubbles behind the executions its sweep aborts', async () => {
    cleanupStaleActive.mockResolvedValue(['stale-1', 'stale-2']);
    findUnfinishedByAgentExecutionIds.mockResolvedValue([{ id: 'stranded-q' }]);

    await runQuestNode({ node: node(), graph: graph(), userId: 'u1', model: 'gpt-x', logger });

    expect(findUnfinishedByAgentExecutionIds).toHaveBeenCalledWith(['stale-1', 'stale-2']);
    expect(settleIfUnfinished).toHaveBeenCalledWith('stranded-q', {
      status: 'done',
      type: 'error',
      reply: ABANDONED_REPLY,
    });
  });

  it('does not touch quests when the sweep found nothing', async () => {
    await runQuestNode({ node: node(), graph: graph(), userId: 'u1', model: 'gpt-x', logger });

    expect(findUnfinishedByAgentExecutionIds).not.toHaveBeenCalled();
  });
});

describe('runQuestNode turn linkage (#1867)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `[]`, not undefined: cleanupStaleActive returns the swept execution ids (#2012), and
    // runQuestNode feeds them to findUnfinishedByAgentExecutionIds.
    cleanupStaleActive.mockResolvedValue([]);
    countActiveByUserId.mockResolvedValue(0);
    claimForRun.mockResolvedValue(node({ status: 'in_progress' }));
    questCreate.mockResolvedValue({ id: 'q1' });
    create.mockResolvedValue({ id: 'exec-1' });
    questUpdateOne.mockResolvedValue(undefined);
    setExecution.mockResolvedValue(node({ status: 'in_progress', execution: { agentExecutionId: 'exec-1' } }));
    lambdaSend.mockResolvedValue(undefined);
    findUnfinishedByAgentExecutionIds.mockResolvedValue([]);
    settleIfUnfinished.mockResolvedValue(true);
  });

  // Without this, a V5 execution that resumes (checkpoint / permission re-invoke) reaches
  // resolveExecutionQuestId with no start payload AND no persisted id, so every LakeAccessEvent
  // from the second invocation on is written unlinked. The first invocation is fine either way
  // (the start payload carries the id), which is exactly what makes the gap silent.
  it('stamps linkedQuestId with the real Quest id at execution-create time', async () => {
    await runQuestNode({ node: node(), graph: graph(), userId: 'u1', model: 'gpt-x', logger });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ linkedQuestId: 'q1' });
  });
});
