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

/** The V2 opt-in. Only consulted when V1 is off - V1 being on already means the event fires. */
const isMementosV2EnabledMock = vi.fn<(userId: string) => Promise<boolean>>();

vi.mock('@server/memory/mementoLedgerMirror', () => ({
  isMementosV2Enabled: (userId: string) => isMementosV2EnabledMock(userId),
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
    isMementosV2EnabledMock.mockReset();
    isMementosV2EnabledMock.mockResolvedValue(false); // default: user is not on V2
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
      enableMementos: true,
    });
    expect(logger.info).toHaveBeenCalledWith('[Mementos] Published completion event', {
      executionId: 'exec-1',
      enableMementos: true,
      // V1 short-circuited the V2 lookup, so the log says 'deferred' rather than a true-because-V1 opt-in.
      enableMementosV2: 'deferred-to-subscriber',
    });
  });

  it('V1 on: does not bother resolving the V2 opt-in - the event fires either way', async () => {
    await publishMementoCompletion(makeExecution(), makeLogger());

    expect(isMementosV2EnabledMock).not.toHaveBeenCalled();
    // ...and it must NOT claim enableMementosV2, which would be true-because-V1-is-on, not because the
    // user opted in. Absent tells the subscriber to resolve it properly.
    expect(publishMock.mock.calls[0][0]).not.toHaveProperty('enableMementosV2');
  });

  it('V1 OFF but V2 ON still publishes - V2 must keep LEARNING', async () => {
    // The regression this exists for: `enableMementos` used to gate the event outright, so switching
    // V1 off silently froze V2's memory. It went on answering from a snapshot it could never add to,
    // which looks like everything working. V2 having its own write path is the precondition for ever
    // deleting V1.
    isMementosV2EnabledMock.mockResolvedValue(true);

    await publishMementoCompletion(makeExecution({ enableMementos: false }), makeLogger());

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ enableMementos: false, enableMementosV2: true })
    );
  });

  it('skips publish when the user is on NEITHER pipeline', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution({ enableMementos: false }), logger);

    expect(publishMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('skips publish when enableMementos is undefined and the user is not on V2', async () => {
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
