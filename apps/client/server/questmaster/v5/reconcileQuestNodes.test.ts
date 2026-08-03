import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestNodeDocument } from '@bike4mind/common';

const updateStatus = vi.fn();

vi.mock('@bike4mind/database', () => ({
  questNodeRepository: { updateStatus: (...args: unknown[]) => updateStatus(...args) },
}));

const { reconcileQuestNodes } = await import('./reconcileQuestNodes');
type NodeRunSummary = Parameters<typeof reconcileQuestNodes>[1] extends Map<string, infer V> ? V : never;

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const node = (over: Partial<IQuestNodeDocument> & { id: string }): IQuestNodeDocument =>
  ({
    graphId: 'g1',
    dependsOn: [],
    order: 0,
    depth: 0,
    kind: 'task',
    title: 't',
    task: 'do it',
    status: 'in_progress',
    enabledTools: [],
    artifactIds: [],
    execution: { agentExecutionId: 'exec-1' },
    ...over,
  }) as IQuestNodeDocument;

const run = (over: Partial<NodeRunSummary> & { id: string }): NodeRunSummary => ({
  status: 'completed',
  answer: null,
  totalIterations: null,
  totalCreditsUsed: null,
  errorMessage: null,
  completedAt: null,
  ...over,
});

const runs = (...entries: NodeRunSummary[]) => new Map(entries.map(r => [r.id, r]));

describe('reconcileQuestNodes', () => {
  beforeEach(() => updateStatus.mockReset());

  it('does not write when nothing is in flight', async () => {
    const nodes = [node({ id: 'n1', status: 'pending', execution: undefined })];
    await expect(reconcileQuestNodes(nodes, runs(), logger)).resolves.toBe(nodes);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('advances an in-flight node whose execution completed', async () => {
    updateStatus.mockResolvedValue(node({ id: 'n1', status: 'completed' }));

    const [result] = await reconcileQuestNodes([node({ id: 'n1' })], runs(run({ id: 'exec-1' })), logger);

    expect(result.status).toBe('completed');
  });

  // A node that finished while nobody was looking must carry the run's real
  // completion time, not the moment somebody happened to open the graph.
  it('stamps completedAt from the execution, not from now', async () => {
    const finishedAt = new Date('2026-07-29T10:00:00.000Z');
    updateStatus.mockResolvedValue(node({ id: 'n1', status: 'completed' }));

    await reconcileQuestNodes([node({ id: 'n1' })], runs(run({ id: 'exec-1', completedAt: finishedAt })), logger);

    expect(updateStatus).toHaveBeenCalledWith('n1', 'completed', { completedAt: finishedAt });
  });

  it('falls back to now when the execution carries no completion time', async () => {
    updateStatus.mockResolvedValue(node({ id: 'n1', status: 'failed' }));

    await reconcileQuestNodes([node({ id: 'n1' })], runs(run({ id: 'exec-1', status: 'failed' })), logger);

    expect(updateStatus).toHaveBeenCalledWith('n1', 'failed', { completedAt: expect.any(Date) });
  });

  it('leaves a node in_progress while its execution is still running', async () => {
    const [result] = await reconcileQuestNodes(
      [node({ id: 'n1' })],
      runs(run({ id: 'exec-1', status: 'running' })),
      logger
    );

    expect(updateStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('in_progress');
  });

  it('leaves the node in_progress when its execution is missing from the batch', async () => {
    const [result] = await reconcileQuestNodes([node({ id: 'n1' })], runs(), logger);

    expect(updateStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('in_progress');
  });

  // A read of the whole graph must not 500 because one node's write failed -
  // the other nodes' statuses are still perfectly good.
  it('keeps the rest of the graph when one write throws', async () => {
    updateStatus
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValueOnce(node({ id: 'n2', status: 'completed' }));

    const result = await reconcileQuestNodes(
      [
        node({ id: 'n1', execution: { agentExecutionId: 'exec-a' } }),
        node({ id: 'n2', execution: { agentExecutionId: 'exec-b' } }),
      ],
      runs(run({ id: 'exec-a' }), run({ id: 'exec-b' })),
      logger
    );

    expect(result.find(n => n.id === 'n1')?.status).toBe('in_progress');
    expect(result.find(n => n.id === 'n2')?.status).toBe('completed');
  });
});
