import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  claimExecution: vi.fn(),
  markFailed: vi.fn(),
  markQuestSettlementFailed: vi.fn(),
}));
const settleStrandedQuests = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ agentExecutionRepository: repo }));
vi.mock('@bike4mind/server-utils/utils/settleStrandedQuests', () => ({ settleStrandedQuests }));
const push = vi.hoisted(() => ({ publishAgentTerminalPush: vi.fn(), createAgentPushDeps: vi.fn(() => ({})) }));
vi.mock('@workers/queueHandlers/agentExecutor.push', () => push);

import { settleDroppedExecution } from './droppedExecution';

const target = { executionId: '0123456789abcdef01234567', claimableFrom: ['continuing' as const] };
const logger = { warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  settleStrandedQuests.mockResolvedValue({ settled: 1, failed: false, failedExecutionIds: [] });
});

describe('settleDroppedExecution', () => {
  it('fails the execution through its own claim statuses and settles its quest', async () => {
    repo.claimExecution.mockResolvedValue(true);
    await expect(settleDroppedExecution(target, logger)).resolves.toBe(true);
    expect(repo.claimExecution).toHaveBeenCalledWith(target.executionId, ['continuing'], 'failed');
    expect(repo.markFailed).toHaveBeenCalledWith(target.executionId, expect.objectContaining({ callerSafe: true }));
    expect(settleStrandedQuests).toHaveBeenCalledWith([target.executionId], logger, expect.any(String));
    expect(repo.markQuestSettlementFailed).not.toHaveBeenCalled();
    expect(push.publishAgentTerminalPush).toHaveBeenCalledExactlyOnceWith(
      { executionId: target.executionId, outcome: 'failed' },
      expect.anything(),
      logger
    );
  });
  it('leaves an execution that already moved on untouched', async () => {
    repo.claimExecution.mockResolvedValue(false);
    await expect(settleDroppedExecution(target, logger)).resolves.toBe(false);
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(settleStrandedQuests).not.toHaveBeenCalled();
    expect(push.publishAgentTerminalPush).not.toHaveBeenCalled();
  });
  it('marks a failed quest settlement for the sweep to retry', async () => {
    repo.claimExecution.mockResolvedValue(true);
    settleStrandedQuests.mockResolvedValue({ settled: 0, failed: true, failedExecutionIds: [target.executionId] });
    await settleDroppedExecution(target, logger);
    expect(repo.markQuestSettlementFailed).toHaveBeenCalledWith([target.executionId]);
  });
});
