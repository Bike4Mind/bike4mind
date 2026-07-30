import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestNodeDocument } from '@bike4mind/common';

const findById = vi.fn();
const updateStatus = vi.fn();

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: { findById: (...args: unknown[]) => findById(...args) },
  questNodeRepository: { updateStatus: (...args: unknown[]) => updateStatus(...args) },
}));

const { reconcileQuestNodes } = await import('./reconcileQuestNodes');

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

describe('reconcileQuestNodes', () => {
  beforeEach(() => {
    findById.mockReset();
    updateStatus.mockReset();
  });

  it('does not touch the database when nothing is in flight', async () => {
    const nodes = [node({ id: 'n1', status: 'pending', execution: undefined })];
    await expect(reconcileQuestNodes(nodes, logger)).resolves.toBe(nodes);
    expect(findById).not.toHaveBeenCalled();
  });

  it('advances an in-flight node whose execution completed', async () => {
    findById.mockResolvedValue({ status: 'completed' });
    updateStatus.mockResolvedValue(node({ id: 'n1', status: 'completed' }));

    const [result] = await reconcileQuestNodes([node({ id: 'n1' })], logger);

    expect(updateStatus).toHaveBeenCalledWith(
      'n1',
      'completed',
      expect.objectContaining({ completedAt: expect.any(Date) })
    );
    expect(result.status).toBe('completed');
  });

  it('leaves a node in_progress while its execution is still running', async () => {
    findById.mockResolvedValue({ status: 'running' });

    const [result] = await reconcileQuestNodes([node({ id: 'n1' })], logger);

    expect(updateStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('in_progress');
  });

  // A read of the whole graph must not 500 because one node's execution is
  // unreadable - the other nodes' statuses are still perfectly good.
  it('keeps the node and the rest of the graph when one lookup throws', async () => {
    findById.mockRejectedValueOnce(new Error('mongo down')).mockResolvedValueOnce({ status: 'completed' });
    updateStatus.mockResolvedValue(node({ id: 'n2', status: 'completed' }));

    const result = await reconcileQuestNodes(
      [node({ id: 'n1', execution: { agentExecutionId: 'bad' } }), node({ id: 'n2' })],
      logger
    );

    expect(result.find(n => n.id === 'n1')?.status).toBe('in_progress');
    expect(result.find(n => n.id === 'n2')?.status).toBe('completed');
  });

  it('leaves the node in_progress when the execution doc has vanished', async () => {
    findById.mockResolvedValue(null);

    const [result] = await reconcileQuestNodes([node({ id: 'n1' })], logger);

    expect(updateStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('in_progress');
  });
});
