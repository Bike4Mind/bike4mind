import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { publishMementoCompletion, type MementoCompletionExecution } from './publishMementoCompletion';

const publishMock = vi.fn<(payload: unknown) => Promise<void>>();

vi.mock('@server/utils/eventBus', () => ({
  LLMEvents: {
    CompletionCompleted: {
      publish: (payload: unknown) => publishMock(payload),
    },
  },
}));

const makeExecution = (overrides: Partial<MementoCompletionExecution> = {}): MementoCompletionExecution => ({
  id: 'exec-1',
  userId: 'user-1',
  sessionId: 'session-1',
  questId: 'quest-1',
  query: 'what is the weather',
  model: 'gpt-5.4',
  enableMementos: true,
  ...overrides,
});

const makeLogger = (): Logger => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
};

describe('publishMementoCompletion', () => {
  beforeEach(() => {
    publishMock.mockReset();
    publishMock.mockResolvedValue(undefined);
  });

  it('publishes CompletionCompleted with the execution payload on the happy path', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution(), logger);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({
      questId: 'quest-1',
      sessionId: 'session-1',
      userId: 'user-1',
      prompt: 'what is the weather',
      model: 'gpt-5.4',
    });
    expect(logger.info).toHaveBeenCalledWith('[Mementos] Published completion event', { executionId: 'exec-1' });
  });

  it('skips publish when enableMementos is false', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution({ enableMementos: false }), logger);

    expect(publishMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('skips publish when enableMementos is undefined', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution({ enableMementos: undefined }), logger);

    expect(publishMock).not.toHaveBeenCalled();
  });

  it('skips publish when parentExecutionId is set (subagent / DAG child)', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution({ parentExecutionId: 'parent-exec-99' }), logger);

    expect(publishMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows publish errors and warn-logs without throwing', async () => {
    const logger = makeLogger();
    publishMock.mockRejectedValueOnce(new Error('SNS down'));

    await expect(publishMementoCompletion(makeExecution(), logger)).resolves.toBeUndefined();

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Mementos] Failed to publish completion event — memento creation skipped',
      { executionId: 'exec-1', error: 'SNS down' }
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
