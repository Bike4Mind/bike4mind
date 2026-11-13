import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOP_NEXT_ACTION_CHARS, LOOP_REFLECTION_CHARS, type IAgentStep } from '@bike4mind/common';

const db = vi.hoisted(() => ({
  agentExecutionRepository: { findById: vi.fn(), setLoopReflection: vi.fn(), incrementCreditsUsed: vi.fn() },
  loopRepository: { findById: vi.fn() },
  workItemRepository: { findById: vi.fn() },
  User: { findById: vi.fn() },
}));
vi.mock('@bike4mind/database', () => db);

const ops = vi.hoisted(() => ({ getOperationsTextModel: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({ OperationsModelService: ops }));

// The meter settles each call for `settleCredits`; `refuse` makes admission throw like a 422.
const meterState = vi.hoisted(() => ({ settleCredits: 2, refuse: false, ceilingUsd: 0.001 }));
vi.mock('@bike4mind/server-utils/billing/meterPlatformCompletion', () => ({
  completionCeilingUsd: () => meterState.ceilingUsd,
  createCompletionMeter: () => async () => {
    if (meterState.refuse) throw Object.assign(new Error('insufficient credits'), { status: 422 });
    return { settle: async () => meterState.settleCredits, refund: async () => {} };
  },
}));

import { reflectLoopRun } from './agentExecutor.loopReflection';

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Parameters<typeof reflectLoopRun>[1];
const complete = vi.fn();
const reply = (json: unknown) =>
  complete.mockImplementation(async (_model, _messages, _options, callback) => {
    await callback([JSON.stringify(json)], { inputTokens: 10, outputTokens: 10 });
  });

const loop = { id: 'loop1', goal: 'Keep CI green', memory: { notes: 'old', nextAction: 'old next' } };
const execution = (patch: Record<string, unknown> = {}) => ({
  id: 'run1',
  userId: 'u1',
  sessionId: 's1',
  loopId: 'loop1',
  workItemId: 't1',
  loopStage: 'build',
  totalCreditsUsed: 5,
  status: 'running',
  ...patch,
});
const steps: IAgentStep[] = [
  { type: 'action', content: 'x', metadata: { toolName: 'web_search', timestamp: 1 } },
  { type: 'observation', content: 'found', metadata: { toolName: 'web_search', timestamp: 2 } },
];
const completedRun = { executionId: 'run1', outcome: 'completed' as const, answer: 'Done.', steps };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(meterState, { settleCredits: 2, refuse: false, ceilingUsd: 0.001 });
  db.agentExecutionRepository.findById.mockResolvedValue(execution());
  db.loopRepository.findById.mockResolvedValue(loop);
  db.workItemRepository.findById.mockResolvedValue({ id: 't1', title: 'Fix flaky test', stage: 'build' });
  db.User.findById.mockResolvedValue({ id: 'u1' });
  ops.getOperationsTextModel.mockResolvedValue({
    llm: { complete },
    modelId: 'ops-model',
    modelInfo: { id: 'ops-model', backend: 'anthropic', max_tokens: 4096 },
  });
  reply({ reflection: 'r'.repeat(2000), nextIntendedAction: 'n'.repeat(500) });
});

describe('reflectLoopRun', () => {
  it('stores a capped reflection on a completed ticket run, with what the call was charged', async () => {
    await reflectLoopRun(completedRun, logger);
    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = complete.mock.calls[0][1].at(-1).content as string;
    expect(prompt).toContain('Ticket: "Fix flaky test" (stage: "build")');
    expect(prompt).toContain('- "web_search": ok');
    expect(db.agentExecutionRepository.setLoopReflection).toHaveBeenCalledWith('run1', {
      reflection: 'r'.repeat(LOOP_REFLECTION_CHARS),
      nextIntendedAction: 'n'.repeat(LOOP_NEXT_ACTION_CHARS),
      credits: 2,
      createdAt: expect.any(Date),
    });
  });

  it('reflects on an ordinary failure from the stored checkpoint', async () => {
    db.agentExecutionRepository.findById.mockResolvedValue(execution({ checkpoint: { steps } }));
    reply({ reflection: 'tool broke', nextIntendedAction: 'retry' });
    await reflectLoopRun({ executionId: 'run1', outcome: 'failed', answer: '', failureReason: 'Timed out' }, logger);
    expect(complete.mock.calls[0][1].at(-1).content).toContain('Outcome: failed - "Timed out"');
    expect(db.agentExecutionRepository.setLoopReflection).toHaveBeenCalledWith(
      'run1',
      expect.objectContaining({ reflection: 'tool broke', nextIntendedAction: 'retry' })
    );
  });

  it.each([
    ['triage', { loopRunKind: 'triage', workItemId: undefined }],
    ['desktop', { runner: 'desktop' }],
    ['subagent', { parentExecutionId: 'parent' }],
    ['aborted', { abortedAt: new Date() }],
    ['budget-stopped', { failureReason: 'credit_cap' }],
    ['not a loop run', { loopId: undefined }],
    ['capped below the hold', { creditCap: 5.5, totalCreditsUsed: 5 }],
  ])('makes no call for a %s run', async (_label, patch) => {
    meterState.ceilingUsd = 0.01;
    db.agentExecutionRepository.findById.mockResolvedValue(execution(patch));
    await reflectLoopRun(completedRun, logger);
    expect(complete).not.toHaveBeenCalled();
    expect(db.agentExecutionRepository.setLoopReflection).not.toHaveBeenCalled();
  });

  it('makes no call for an idle goal run (memory unchanged), but does when memory moved', async () => {
    db.agentExecutionRepository.findById.mockResolvedValue(execution({ workItemId: undefined }));
    const memoryBlock = (notes: string) =>
      'Nothing new.\n```loop-memory\n' + JSON.stringify({ notes, nextAction: 'old next' }) + '\n```';
    await reflectLoopRun({ ...completedRun, answer: memoryBlock('old') }, logger);
    expect(complete).not.toHaveBeenCalled();
    await reflectLoopRun({ ...completedRun, answer: memoryBlock('new') }, logger);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('makes no call for a credit refusal or a run that failed before any step', async () => {
    db.agentExecutionRepository.findById.mockResolvedValue(execution({ checkpoint: { steps } }));
    const refusal = Object.assign(new Error('no credits'), { additionalInfo: { errorCode: 'insufficient_credits' } });
    await reflectLoopRun({ executionId: 'run1', outcome: 'failed', answer: '', error: refusal }, logger);
    db.agentExecutionRepository.findById.mockResolvedValue(execution());
    await reflectLoopRun({ executionId: 'run1', outcome: 'failed', answer: '' }, logger);
    expect(complete).not.toHaveBeenCalled();
  });

  it('stores nothing and does not throw when the meter refuses or the model is unavailable', async () => {
    meterState.refuse = true;
    await expect(reflectLoopRun(completedRun, logger)).resolves.toBeUndefined();
    ops.getOperationsTextModel.mockRejectedValue(new Error('no operations model'));
    await expect(reflectLoopRun(completedRun, logger)).resolves.toBeUndefined();
    expect(db.agentExecutionRepository.setLoopReflection).not.toHaveBeenCalled();
    expect(db.agentExecutionRepository.incrementCreditsUsed).not.toHaveBeenCalled();
    const failures = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => message === '[Loops] Run reflection failed');
    expect(failures).toHaveLength(2);
  });

  it('still adds the credits of a billed attempt when the call then fails', async () => {
    complete
      .mockImplementationOnce(async (_m, _msgs, _o, callback) => {
        await callback(['not json'], { inputTokens: 10, outputTokens: 10 });
      })
      .mockImplementationOnce(async () => {
        throw new Error('timeout');
      });
    await reflectLoopRun(completedRun, logger);
    expect(db.agentExecutionRepository.incrementCreditsUsed).toHaveBeenCalledWith('run1', 2);
    expect(db.agentExecutionRepository.setLoopReflection).not.toHaveBeenCalled();
  });
});
