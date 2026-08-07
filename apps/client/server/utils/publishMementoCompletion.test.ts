import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { MementoGates } from '@bike4mind/services';
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

  it('publishes the resolved gates verbatim on the happy path (V1 on)', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution(), { v1: true, v2: false }, logger);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({
      questId: 'quest-1',
      sessionId: 'session-1',
      userId: 'user-1',
      prompt: 'what is the weather',
      model: 'gpt-5.4',
      enableMementos: true,
      enableMementosV2: false,
    });
    expect(logger.info).toHaveBeenCalledWith('[Mementos] Published completion event', {
      executionId: 'exec-1',
      enableMementos: true,
      enableMementosV2: false,
    });
  });

  it('V1 OFF but V2 ON still publishes - V2 must keep LEARNING', async () => {
    // The regression this exists for: memory used to be gated on `enableMementos` outright, so
    // switching V1 off silently froze V2's memory. It went on answering from a snapshot it could
    // never add to, which looks like everything working. V2 having its own write gate is the
    // precondition for ever deleting V1. Here V1 is off (undefined -> V2-only user), V2 opted in.
    await publishMementoCompletion(makeExecution(), { v1: false, v2: true }, makeLogger());

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ enableMementos: false, enableMementosV2: true })
    );
  });

  it('skips publish when BOTH gates are off - the per-request opt-out (#1337)', async () => {
    // `enableMementos: false` from a V2-opted user resolves to { v1: false, v2: false }. This is the
    // whole point of #1337: the opt-out must stop the WRITE too, on the agent surface, not just chat.
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution(), { v1: false, v2: false }, logger);

    expect(publishMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('skips publish when parentExecutionId is set (subagent / DAG child)', async () => {
    const logger = makeLogger();
    await publishMementoCompletion(
      makeExecution({ parentExecutionId: 'parent-exec-99' }),
      { v1: true, v2: true },
      logger
    );

    expect(publishMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('OMITS enableMementosV2 when the opt-in lookup failed, so the subscriber resolves it instead', async () => {
    // A `v2: false` from a rejected lookup is "we could not tell", not "opted out". Asserting it would
    // cost a V2 user a turn of learning over a Mongo blip; omitting the field lets the subscriber
    // resolve the opt-in on its own, which is what this surface did before it published explicit
    // booleans. V1 is on here because that is the only way the event exists at all in this case.
    const logger = makeLogger();
    await publishMementoCompletion(makeExecution(), { v1: true, v2: false, v2OptInLookupFailed: true }, logger);

    expect(publishMock).toHaveBeenCalledTimes(1);
    const payload = publishMock.mock.calls[0][0];
    expect(payload).toMatchObject({ enableMementos: true });
    expect('enableMementosV2' in payload).toBe(false);
    expect(logger.info).toHaveBeenCalledWith('[Mementos] Published completion event', {
      executionId: 'exec-1',
      enableMementos: true,
      enableMementosV2: 'deferred-to-subscriber (opt-in lookup failed)',
    });
  });

  it('publishes an explicit enableMementosV2: false when the opt-in genuinely resolved off', async () => {
    // The contrast case for the test above - a real resolved `false` MUST still be asserted, or the
    // subscriber would re-resolve and could write for a user who is legitimately not opted in.
    await publishMementoCompletion(makeExecution(), { v1: true, v2: false, v2OptInLookupFailed: false }, makeLogger());

    expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ enableMementosV2: false }));
  });

  it('skips publish for a BACKGROUND subagent, which sets spawnedByExecutionId and NO parentExecutionId', async () => {
    // The leak this closes (#1337): a background child is created with `parentExecutionId` deliberately
    // unset (it bills and counts independently) and `spawnedByExecutionId` set, and `baseFields` never
    // copies the parent's `enableMementos` - so the child arrives `undefined` and resolves V2 back ON
    // for any opted-in user, writing beliefs from a turn the parent opted out of. Gates are BOTH on
    // here on purpose: the guard must refuse a background child on its lineage alone, independently of
    // how the gates resolved, or this test would pass for the wrong reason.
    const logger = makeLogger();
    await publishMementoCompletion(
      makeExecution({ spawnedByExecutionId: 'spawner-exec-42' }),
      { v1: true, v2: true },
      logger
    );

    expect(publishMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows publish errors and warn-logs without throwing', async () => {
    const logger = makeLogger();
    publishMock.mockRejectedValueOnce(new Error('SNS down'));

    await expect(
      publishMementoCompletion(makeExecution(), { v1: true, v2: false } satisfies MementoGates, logger)
    ).resolves.toBeUndefined();

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Mementos] Failed to publish completion event — memento creation skipped',
      {
        executionId: 'exec-1',
        error: 'SNS down',
      }
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
