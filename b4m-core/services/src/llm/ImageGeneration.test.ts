import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService } from './ImageGeneration';
import { SUMMARIZATION_CONFIG } from './ChatCompletionFeatures';
import { ImageModels, type ISessionDocument, type ModelInfo } from '@bike4mind/common';
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

describe('ImageGenerationService.selectInputImage', () => {
  type FakeFile = { id: string; filePath: string; mimeType: string; moderationStatus: string };
  const cleanImage = (id: string): FakeFile => ({
    id,
    filePath: `fab/${id}.png`,
    mimeType: 'image/png',
    moderationStatus: 'clean',
  });

  const makeService = (opts: { fabFilesById?: Record<string, FakeFile>; recentMessages?: unknown[] }) => {
    const findAllInIds = vi.fn(async (ids: string[]) => (ids || []).map(id => opts.fabFilesById?.[id]).filter(Boolean));
    const getMostRecentChatHistory = vi.fn(async () => opts.recentMessages ?? []);
    const service = new ImageGenerationService({
      db: { fabFiles: { findAllInIds }, quests: { getMostRecentChatHistory } },
    } as any);
    return { service, findAllInIds, getMostRecentChatHistory };
  };

  const select = (
    service: ImageGenerationService,
    args: { model: string; supportsImageVariation: boolean; intent?: 'fresh' | 'continuation'; fabFileIds?: string[] }
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).selectInputImage({
      sessionId: 's1',
      fabFileIds: args.fabFileIds ?? [],
      model: args.model,
      modelInfo: { supportsImageVariation: args.supportsImageVariation } as ModelInfo,
      intent: args.intent ?? 'fresh',
      logger: silentLogger,
    });

  it('resolves a Kontext input image from a user attachment earlier in the notebook (the bug)', async () => {
    // No workbench upload; the image the user attached to a prior message must be found so
    // Kontext (a required-input model) does not falsely report "no input image".
    const { service } = makeService({
      fabFilesById: { f1: cleanImage('f1') },
      recentMessages: [{ id: 'm1', type: 'message', timestamp: new Date(0), fabFileIds: ['f1'] }],
    });

    const result = await select(service, {
      model: ImageModels.FLUX_KONTEXT_PRO,
      supportsImageVariation: true,
    });

    expect(result.fileImage?.id).toBe('f1');
    expect(result.imageSource).toBe('notebook_attachment');
  });

  it('returns no image for Kontext when the notebook has none (downstream throws the guidance error)', async () => {
    const { service } = makeService({ recentMessages: [] });
    const result = await select(service, {
      model: ImageModels.FLUX_KONTEXT_PRO,
      supportsImageVariation: true,
    });
    expect(result.fileImage).toBeUndefined();
  });

  it("drops a workbench attachment for a 'none' model so it is never sent to the provider", async () => {
    const { service } = makeService({ fabFilesById: { w1: cleanImage('w1') } });
    const result = await select(service, {
      model: ImageModels.DALL_E_2, // not required, no variation support -> 'none'
      supportsImageVariation: false,
      fabFileIds: ['w1'],
    });
    expect(result.fileImage).toBeUndefined();
  });

  it('carries a prior generated image forward for an optional model on a continuation', async () => {
    const { service } = makeService({
      recentMessages: [{ id: 'm1', type: 'message', timestamp: new Date(0), images: ['gen/img1.png'] }],
    });
    const result = await select(service, {
      model: ImageModels.GPT_IMAGE_2,
      supportsImageVariation: true,
      intent: 'continuation',
    });
    expect(result.fileImage?.filePath).toBe('gen/img1.png');
    expect(result.imageSource).toBe('message_history');
  });

  it('does NOT carry a notebook image forward for an optional model on a fresh prompt', async () => {
    const { service } = makeService({
      fabFilesById: { f1: cleanImage('f1') },
      recentMessages: [{ id: 'm1', type: 'message', timestamp: new Date(0), fabFileIds: ['f1'] }],
    });
    const result = await select(service, {
      model: ImageModels.GPT_IMAGE_2,
      supportsImageVariation: true,
      intent: 'fresh',
    });
    expect(result.fileImage).toBeUndefined();
  });

  it('prefers the workbench upload over any notebook-context image', async () => {
    const { service } = makeService({
      fabFilesById: { w1: cleanImage('w1'), f1: cleanImage('f1') },
      recentMessages: [{ id: 'm1', type: 'message', timestamp: new Date(0), fabFileIds: ['f1'] }],
    });
    const result = await select(service, {
      model: ImageModels.FLUX_KONTEXT_PRO,
      supportsImageVariation: true,
      fabFileIds: ['w1'],
    });
    expect(result.fileImage?.id).toBe('w1');
    expect(result.imageSource).toBe('workbench');
  });

  it('skips error turns and unserveable attachments when scanning notebook history', async () => {
    const { service } = makeService({
      fabFilesById: {
        pending: { id: 'pending', filePath: 'fab/pending.png', mimeType: 'image/png', moderationStatus: 'pending' },
        good: cleanImage('good'),
      },
      recentMessages: [
        { id: 'm1', type: 'error', timestamp: new Date(2), images: ['gen/err.png'] },
        { id: 'm2', type: 'message', timestamp: new Date(1), fabFileIds: ['pending'] },
        { id: 'm3', type: 'message', timestamp: new Date(0), fabFileIds: ['good'] },
      ],
    });
    const result = await select(service, {
      model: ImageModels.FLUX_KONTEXT_PRO,
      supportsImageVariation: true,
    });
    expect(result.fileImage?.id).toBe('good');
    expect(result.imageSource).toBe('notebook_attachment');
  });
});
