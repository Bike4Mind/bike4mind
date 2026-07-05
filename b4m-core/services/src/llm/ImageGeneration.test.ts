import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService } from './ImageGeneration';
import { SUMMARIZATION_CONFIG } from './ChatCompletionFeatures';
import type { ISessionDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const makeService = (overrides: {
  invokeSummarizeSession?: ReturnType<typeof vi.fn>;
  session?: Partial<ISessionDocument> | null;
  totalQuests?: number;
}) => {
  const findById = vi.fn(async () =>
    overrides.session === null ? null : ({ id: 'session1', ...overrides.session } as ISessionDocument)
  );
  const count = vi.fn(async () => overrides.totalQuests ?? 0);

  const service = new ImageGenerationService({
    db: { sessions: { findById }, quests: { count } },
    invokeSummarizeSession: overrides.invokeSummarizeSession,
  } as any);
  return { service, findById, count };
};

describe('ImageGenerationService.maybeSummarizeAfterImage', () => {
  it('does nothing when invokeSummarizeSession is not configured', async () => {
    const { service, findById } = makeService({ invokeSummarizeSession: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).maybeSummarizeAfterImage('session1', silentLogger);
    expect(findById).not.toHaveBeenCalled();
  });

  it('invokes the callback with the trigger returned by shouldSummarizeSession', async () => {
    const invokeSummarizeSession = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      invokeSummarizeSession,
      session: { id: 'session1', summaryAt: undefined },
      totalQuests: SUMMARIZATION_CONFIG.earlyMilestoneQuestCount,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).maybeSummarizeAfterImage('session1', silentLogger);
    expect(invokeSummarizeSession).toHaveBeenCalledWith('session1', 'earlyMilestone');
  });

  it('skips with a debug log when the session lookup misses', async () => {
    const invokeSummarizeSession = vi.fn().mockResolvedValue(undefined);
    const debug = vi.fn();
    const logger = { ...silentLogger, debug } as unknown as Logger;
    const { service } = makeService({ invokeSummarizeSession, session: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).maybeSummarizeAfterImage('missing-session', logger);
    expect(invokeSummarizeSession).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('missing-session'));
  });

  it('does NOT invoke the callback when no summarization trigger is met', async () => {
    const invokeSummarizeSession = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      invokeSummarizeSession,
      session: { id: 'session1', summaryAt: undefined },
      totalQuests: SUMMARIZATION_CONFIG.earlyMilestoneQuestCount - 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).maybeSummarizeAfterImage('session1', silentLogger);
    expect(invokeSummarizeSession).not.toHaveBeenCalled();
  });
});
