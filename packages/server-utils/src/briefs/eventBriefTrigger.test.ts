import { describe, expect, it, vi } from 'vitest';
import { startEventBriefForCompletedRun } from './eventBriefTrigger';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

describe('startEventBriefForCompletedRun', () => {
  it('starts a brief for a top-level run and logs the outcome', async () => {
    const logger = makeLogger();
    const start = vi.fn().mockResolvedValue('enqueued');
    await startEventBriefForCompletedRun('e1', { userId: 'u1' }, logger, start);
    expect(start).toHaveBeenCalledWith('u1');
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { executionId: 'e1', outcome: 'enqueued' });
  });

  it.each([
    ['a missing execution', null],
    ['a subagent', { userId: 'u1', parentExecutionId: 'p1' }],
    ['a spawned background run', { userId: 'u1', spawnedByExecutionId: 'p1' }],
    ['a DAG node', { userId: 'u1', dagNodeId: 'n1' }],
  ])('skips %s', async (_label, execution) => {
    const start = vi.fn();
    await startEventBriefForCompletedRun('e1', execution, makeLogger(), start);
    expect(start).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed start', async () => {
    const logger = makeLogger();
    const start = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(startEventBriefForCompletedRun('e1', { userId: 'u1' }, logger, start)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { executionId: 'e1', error: 'db down' });
  });
});
