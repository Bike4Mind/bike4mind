import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDagSpec, AgentExecutionStatus } from '@bike4mind/database';

vi.mock('sst', () => ({
  Resource: {
    agentContinuationQueue: { url: 'mock-queue-url' },
  },
}));

// `@bike4mind/agents` dist imports `zod`, which doesn't resolve from the
// hoisted dist path under Vite/Vitest. Re-export thin pure copies of the
// DAG helpers we actually call so the test boundary is purely behavioural
// and free of the build-time zod resolution snag.
vi.mock('@bike4mind/agents', () => {
  type Task = { id: string; description: string; agentType: string; dependsOn: string[]; onFailure: string };
  type Input = { tasks: Task[] };
  type Result = { id: string; description: string; agentType: string; status: string; result?: string; error?: string };

  return {
    findReadyTasks(
      input: Input,
      completedIds: ReadonlySet<string>,
      pendingIds: ReadonlySet<string>,
      isolatedFailedIds: ReadonlySet<string> = new Set()
    ): string[] {
      return input.tasks
        .filter(t => pendingIds.has(t.id) && t.dependsOn.every(d => completedIds.has(d) || isolatedFailedIds.has(d)))
        .map(t => t.id);
    },
    findCascadeDoomed(input: Input, pendingIds: ReadonlySet<string>, cascadeFailedIds: ReadonlySet<string>): string[] {
      return input.tasks
        .filter(t => pendingIds.has(t.id) && t.dependsOn.some(d => cascadeFailedIds.has(d)))
        .map(t => t.id);
    },
    buildPipelineResult(taskResults: Result[]): { summary: string; success: boolean } {
      const completed = taskResults.filter(t => t.status === 'completed');
      const failed = taskResults.filter(t => t.status === 'failed');
      const cascade = taskResults.filter(t => t.status === 'cascade_failed');
      const total = taskResults.length;
      const success = failed.length === 0 && cascade.length === 0 && completed.length === total;
      const lines: string[] = [];
      lines.push(`# DAG result`);
      lines.push(``);
      lines.push(`## Completed Tasks (${completed.length}/${total})`);
      for (const t of completed) lines.push(`- ${t.id}: ${t.result ?? ''}`);
      if (failed.length > 0) {
        lines.push(``);
        lines.push(`## Failed Tasks (${failed.length})`);
        for (const t of failed) lines.push(`- ${t.id}: ${t.error ?? 'Unknown error'}`);
      }
      if (cascade.length > 0) {
        lines.push(``);
        lines.push(`## Cascade-Failed Tasks (${cascade.length})`);
        for (const t of cascade) lines.push(`- ${t.id}: ${t.error ?? 'Cascade-failed'}`);
      }
      return { summary: lines.join('\n'), success };
    },
  };
});

// Capture every SQS send so each test can assert the dispatch shape.
// `SQSClient` and `SendMessageCommand` must be real constructors (vi.fn arrow
// wrappers aren't `new`-able), so we declare them as classes.
const sqsSendMock = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class MockSQSClient {
    send = sqsSendMock;
  },
  SendMessageCommand: class MockSendMessageCommand {
    constructor(public input: unknown) {}
  },
}));

// agentExecutionRepository methods are referenced by `onDagNodeTerminal`.
// Define mocks at module scope so tests can rewrite return values per case.
const findByIdMock = vi.fn();
const findDagChildrenLeanMock = vi.fn();
const markFailedMock = vi.fn().mockResolvedValue(undefined);
const createMock = vi.fn().mockImplementation(async () => ({ id: 'child-1' }));

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
    findDagChildrenLean: (...args: unknown[]) => findDagChildrenLeanMock(...args),
    markFailed: (...args: unknown[]) => markFailedMock(...args),
    create: (...args: unknown[]) => createMock(...args),
  },
}));

// Import AFTER mocks are registered so the module picks up our stubs.
const {
  buildDagResumeReport,
  clampMaxIterationsForOverCapAggregationWake,
  isDagAggregationWake,
  makeDagDispatcher,
  onDagNodeTerminal,
} = await import('./agentExecutorDag');

const spec: IDagSpec = {
  toolUseId: 'tool_use_1',
  tasks: [
    {
      id: 'explore',
      description: 'Search code',
      agentType: 'explore',
      dependsOn: [],
      onFailure: 'cascade',
    },
    {
      id: 'implement',
      description: 'Write code',
      agentType: 'general-purpose',
      dependsOn: ['explore'],
      onFailure: 'cascade',
    },
    {
      id: 'review',
      description: 'Review',
      agentType: 'review',
      dependsOn: ['implement'],
      onFailure: 'cascade',
    },
  ],
};

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof onDagNodeTerminal>[0]['logger'];

type ChildShape = {
  _id: string;
  dagNodeId: string;
  status: AgentExecutionStatus;
  blockedBy?: string[];
};

function setSiblings(children: ChildShape[]): void {
  findDagChildrenLeanMock.mockResolvedValue(children);
}

function setParent(dagSpec: IDagSpec): void {
  findByIdMock.mockResolvedValue({ dagSpec });
}

function getEnqueuedBodies(): Array<Record<string, unknown>> {
  return sqsSendMock.mock.calls.map(call => {
    const cmdInput = call[0]?.input as { MessageBody?: string } | undefined;
    return cmdInput?.MessageBody ? (JSON.parse(cmdInput.MessageBody) as Record<string, unknown>) : {};
  });
}

describe('buildDagResumeReport', () => {
  it('marks success when all nodes completed', () => {
    const report = buildDagResumeReport({
      dagSpec: spec,
      children: [
        { dagNodeId: 'explore', status: 'completed', result: { answer: 'found stuff' } },
        { dagNodeId: 'implement', status: 'completed', result: { answer: 'wrote code' } },
        { dagNodeId: 'review', status: 'completed', result: { answer: 'lgtm' } },
      ],
    });
    expect(report.success).toBe(true);
    expect(report.failedNodes).toEqual([]);
    expect(report.summary).toContain('Completed Tasks (3/3)');
    expect(report.summary).toContain('found stuff');
    expect(report.summary).toContain('lgtm');
  });

  it('reports failed + cascade_failed nodes', () => {
    const report = buildDagResumeReport({
      dagSpec: spec,
      children: [
        { dagNodeId: 'explore', status: 'failed', error: { message: 'boom' } },
        // implement is still pending - should be marked cascade_failed in report
        { dagNodeId: 'implement', status: 'pending' },
        { dagNodeId: 'review', status: 'pending' },
      ],
    });
    expect(report.success).toBe(false);
    expect(report.failedNodes).toEqual(['explore', 'implement', 'review']);
    expect(report.summary).toContain('Failed Tasks (1)');
    expect(report.summary).toContain('boom');
    expect(report.summary).toContain('Cascade-Failed Tasks (2)');
  });

  it('partial completion is surfaced', () => {
    const report = buildDagResumeReport({
      dagSpec: spec,
      children: [
        { dagNodeId: 'explore', status: 'completed', result: { answer: 'found' } },
        { dagNodeId: 'implement', status: 'failed', error: { message: 'compile err' } },
        { dagNodeId: 'review', status: 'pending' },
      ],
    });
    expect(report.success).toBe(false);
    expect(report.failedNodes.sort()).toEqual(['implement', 'review']);
    expect(report.summary).toContain('Completed Tasks (1/3)');
    expect(report.summary).toContain('Failed Tasks (1)');
    expect(report.summary).toContain('compile err');
    expect(report.summary).toContain('Cascade-Failed Tasks (1)');
  });

  it('aborted children are treated as failed', () => {
    const report = buildDagResumeReport({
      dagSpec: spec,
      children: [
        { dagNodeId: 'explore', status: 'aborted' },
        { dagNodeId: 'implement', status: 'pending' },
        { dagNodeId: 'review', status: 'pending' },
      ],
    });
    expect(report.success).toBe(false);
    expect(report.failedNodes).toContain('explore');
    expect(report.summary).toContain('Failed Tasks (1)');
    expect(report.summary).toMatch(/Aborted|Unknown error/);
  });
});

describe('isDagAggregationWake', () => {
  it('is true only when resuming a DAG wake with both dagSpec and waitingOnDagChildren present', () => {
    expect(
      isDagAggregationWake({ isDagResume: true, dagSpec: spec, waitingOnDagChildren: { toolUseId: 'tool_use_1' } })
    ).toBe(true);
  });

  it('is false when not a DAG resume, even with a stale dagSpec/waitingOnDagChildren left on the doc', () => {
    expect(
      isDagAggregationWake({ isDagResume: false, dagSpec: spec, waitingOnDagChildren: { toolUseId: 'tool_use_1' } })
    ).toBe(false);
  });

  it('is false when resuming but dagSpec is missing', () => {
    expect(
      isDagAggregationWake({ isDagResume: true, dagSpec: undefined, waitingOnDagChildren: { toolUseId: 'tool_use_1' } })
    ).toBe(false);
  });

  it('is false when resuming but waitingOnDagChildren is missing', () => {
    expect(isDagAggregationWake({ isDagResume: true, dagSpec: spec, waitingOnDagChildren: undefined })).toBe(false);
  });

  it('is false when both are missing', () => {
    expect(isDagAggregationWake({ isDagResume: true, dagSpec: undefined, waitingOnDagChildren: undefined })).toBe(
      false
    );
  });
});

describe('clampMaxIterationsForOverCapAggregationWake', () => {
  it('caps to the next iteration when the wake is aggregation-only and the member is over cap', () => {
    expect(
      clampMaxIterationsForOverCapAggregationWake({
        isAggregationOnlyWake: true,
        isOverCap: true,
        maxIterations: 25,
        iterationIndex: 7,
      })
    ).toBe(8);
  });

  it('never raises the ceiling above the original maxIterations', () => {
    expect(
      clampMaxIterationsForOverCapAggregationWake({
        isAggregationOnlyWake: true,
        isOverCap: true,
        maxIterations: 5,
        iterationIndex: 20,
      })
    ).toBe(5);
  });

  it('leaves maxIterations untouched when not an aggregation-only wake, even if over cap', () => {
    expect(
      clampMaxIterationsForOverCapAggregationWake({
        isAggregationOnlyWake: false,
        isOverCap: true,
        maxIterations: 25,
        iterationIndex: 7,
      })
    ).toBe(25);
  });

  it('leaves maxIterations untouched on an aggregation-only wake when under cap', () => {
    expect(
      clampMaxIterationsForOverCapAggregationWake({
        isAggregationOnlyWake: true,
        isOverCap: false,
        maxIterations: 25,
        iterationIndex: 7,
      })
    ).toBe(25);
  });
});

describe('onDagNodeTerminal', () => {
  beforeEach(() => {
    sqsSendMock.mockClear();
    findByIdMock.mockReset();
    findDagChildrenLeanMock.mockReset();
    markFailedMock.mockClear();
  });

  it('dispatches a sibling whose deps are now satisfied', async () => {
    setParent(spec);
    setSiblings([
      { _id: 'child-explore', dagNodeId: 'explore', status: 'completed' },
      { _id: 'child-implement', dagNodeId: 'implement', status: 'pending', blockedBy: ['explore'] },
      { _id: 'child-review', dagNodeId: 'review', status: 'pending', blockedBy: ['implement'] },
    ]);

    await onDagNodeTerminal({
      child: { id: 'child-explore', parentExecutionId: 'parent-1', dagNodeId: 'explore', status: 'completed' },
      connectionId: 'conn-1',
      logger: silentLogger,
    });

    const bodies = getEnqueuedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      kind: 'dag_node_dispatch',
      childExecutionId: 'child-implement',
      dagNodeId: 'implement',
    });
    // Parent should NOT be enqueued - there's still pending work.
    expect(bodies.find(b => b.kind === 'continuation')).toBeUndefined();
  });

  it('does NOT dispatch a sibling whose deps are still unsatisfied', async () => {
    setParent(spec);
    setSiblings([
      { _id: 'child-explore', dagNodeId: 'explore', status: 'completed' },
      { _id: 'child-implement', dagNodeId: 'implement', status: 'pending', blockedBy: ['explore'] },
      { _id: 'child-review', dagNodeId: 'review', status: 'pending', blockedBy: ['implement'] },
    ]);

    await onDagNodeTerminal({
      child: { id: 'child-explore', parentExecutionId: 'parent-1', dagNodeId: 'explore', status: 'completed' },
      connectionId: 'conn-1',
      logger: silentLogger,
    });

    const reviewDispatched = getEnqueuedBodies().some(b => b.dagNodeId === 'review');
    expect(reviewDispatched).toBe(false);
  });

  it('cascade-failed root: transitively-doomed descendants are marked failed', async () => {
    setParent(spec);
    setSiblings([
      { _id: 'child-explore', dagNodeId: 'explore', status: 'failed' },
      { _id: 'child-implement', dagNodeId: 'implement', status: 'pending', blockedBy: ['explore'] },
      { _id: 'child-review', dagNodeId: 'review', status: 'pending', blockedBy: ['implement'] },
    ]);

    await onDagNodeTerminal({
      child: { id: 'child-explore', parentExecutionId: 'parent-1', dagNodeId: 'explore', status: 'failed' },
      connectionId: 'conn-1',
      logger: silentLogger,
    });

    // Both descendants should be cascade-marked.
    const markedIds = markFailedMock.mock.calls.map(c => c[0]);
    expect(markedIds).toContain('child-implement');
    expect(markedIds).toContain('child-review');

    // Reason mentions the dep that broke the chain.
    const reasons = markFailedMock.mock.calls.map(c => (c[1] as { message: string }).message);
    expect(reasons.some(m => m.includes('explore'))).toBe(true);

    // Parent continuation is enqueued because the DAG can never make further progress.
    const bodies = getEnqueuedBodies();
    expect(bodies.find(b => b.kind === 'continuation')).toMatchObject({
      kind: 'continuation',
      executionId: 'parent-1',
    });
  });

  it('when all siblings are terminal, exactly one parent continuation is enqueued', async () => {
    setParent(spec);
    setSiblings([
      { _id: 'child-explore', dagNodeId: 'explore', status: 'completed' },
      { _id: 'child-implement', dagNodeId: 'implement', status: 'completed' },
      // review just finished - passed as the firing terminal child.
      { _id: 'child-review', dagNodeId: 'review', status: 'completed' },
    ]);

    await onDagNodeTerminal({
      child: { id: 'child-review', parentExecutionId: 'parent-1', dagNodeId: 'review', status: 'completed' },
      connectionId: 'conn-1',
      logger: silentLogger,
    });

    const continuations = getEnqueuedBodies().filter(b => b.kind === 'continuation');
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ executionId: 'parent-1' });
  });

  it('isolate policy: dependents proceed even when the dep failed', async () => {
    const isolateSpec: IDagSpec = {
      toolUseId: 'tool_use_iso',
      tasks: [
        {
          id: 'fanout-a',
          description: 'Risky lookup',
          agentType: 'explore',
          dependsOn: [],
          // failure of this node should NOT poison the synthesizer
          onFailure: 'isolate',
        },
        {
          id: 'fanout-b',
          description: 'Other lookup',
          agentType: 'explore',
          dependsOn: [],
          onFailure: 'isolate',
        },
        {
          id: 'synthesize',
          description: 'Aggregate',
          agentType: 'general-purpose',
          dependsOn: ['fanout-a', 'fanout-b'],
          onFailure: 'cascade',
        },
      ],
    };
    setParent(isolateSpec);
    setSiblings([
      { _id: 'child-a', dagNodeId: 'fanout-a', status: 'failed' },
      { _id: 'child-b', dagNodeId: 'fanout-b', status: 'completed' },
      { _id: 'child-synth', dagNodeId: 'synthesize', status: 'pending', blockedBy: ['fanout-a', 'fanout-b'] },
    ]);

    await onDagNodeTerminal({
      child: { id: 'child-a', parentExecutionId: 'parent-iso', dagNodeId: 'fanout-a', status: 'failed' },
      connectionId: 'conn-1',
      logger: silentLogger,
    });

    // The synthesize node should be dispatched despite fanout-a having failed.
    const dispatched = getEnqueuedBodies().filter(b => b.kind === 'dag_node_dispatch');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ dagNodeId: 'synthesize', childExecutionId: 'child-synth' });

    // markFailed should NOT have been called on the synthesizer (no cascade).
    expect(markFailedMock).not.toHaveBeenCalledWith('child-synth', expect.anything());
  });

  it('no-op when child has no dagNodeId or parentExecutionId', async () => {
    await onDagNodeTerminal({
      child: { id: 'orphan', parentExecutionId: undefined, dagNodeId: 'x', status: 'completed' },
      connectionId: 'conn-1',
      logger: silentLogger,
    });
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(sqsSendMock).not.toHaveBeenCalled();
  });
});

describe('makeDagDispatcher artifact opt-out inheritance', () => {
  const nodeDefaultsBase = {
    userId: 'u1',
    organizationId: 'o1',
    sessionId: 's1',
    questId: 'q1',
  };
  const node = { id: 'explore', description: 'Search code', dependsOn: [] as string[] };

  async function createNodeWith(enableArtifacts?: boolean): Promise<void> {
    createMock.mockClear();
    const dispatcher = makeDagDispatcher({
      connectionId: 'c1',
      nodeDefaults: { ...nodeDefaultsBase, ...(enableArtifacts !== undefined && { enableArtifacts }) },
      logger: silentLogger,
    });
    await dispatcher.createNode({
      parentExecutionId: 'p1',
      node,
      thoroughness: 'quick',
      agentName: 'worker',
      model: 'm1',
      maxIterations: 3,
    });
  }

  it('passes the parent artifact opt-out down to each DAG node', async () => {
    // The PR's headline design claim: the flag is a caller opt-OUT, not a grant, so a delegating
    // agent must not be able to route around it by fanning out.
    await createNodeWith(false);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ enableArtifacts: false }));
  });

  it('leaves the key absent when the parent expressed no preference', async () => {
    // `undefined` vs `false` is the load-bearing distinction: absence means "admin setting decides",
    // so a stamped `false` here would strip artifacts from every internal dispatch.
    //
    // Asserted on the key list, not via `not.objectContaining({ enableArtifacts: expect.anything() })`:
    // `expect.anything()` does not match an explicit `undefined`, so that form passes even if the
    // conditional spread is replaced by a bare `enableArtifacts: nodeDefaults.enableArtifacts`.
    await createNodeWith(undefined);
    expect(Object.keys(createMock.mock.calls[0][0] as Record<string, unknown>)).not.toContain('enableArtifacts');
  });

  it('passes an explicit opt-in through unchanged', async () => {
    await createNodeWith(true);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ enableArtifacts: true }));
  });
});
