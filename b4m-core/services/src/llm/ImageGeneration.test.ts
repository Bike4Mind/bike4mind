import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService } from './ImageGeneration';
import { SUMMARIZATION_CONFIG } from './ChatCompletionFeatures';
import {
  ImageModels,
  MAX_REFERENCE_IMAGES,
  ModelBackend,
  type ISessionDocument,
  type ModelInfo,
} from '@bike4mind/common';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { OMITTED_QUALITY_TIER } from './imageCostCalculator/OpenAIImageCostCalculator';
import type { Logger } from '@bike4mind/observability';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn() };
});

vi.mock('../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../apiKeyService')>();
  return { ...actual, getEffectiveLLMApiKeys: vi.fn(async () => ({ gemini: 'gemini-key' })) };
});

const mockGeminiEdit = vi.fn();
const mockGeminiGenerate = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    aiImageService: vi.fn(() => ({ edit: mockGeminiEdit, generate: mockGeminiGenerate })),
    getSettingsMap: vi.fn().mockResolvedValue({}),
    ClientMessageSender: vi.fn().mockImplementation(function () {
      return { sendToClient: vi.fn().mockResolvedValue(undefined) };
    }),
  };
});

vi.mock('./questHeartbeat', () => ({
  startQuestHeartbeat: vi.fn().mockResolvedValue(() => undefined),
}));

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as unknown as Logger;

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
    // Access-scoped lookup: the mock returns only the ids configured as accessible in
    // fabFilesById, mirroring the repo dropping ids the caller cannot access.
    const findAccessibleInIds = vi.fn(async (ids: string[]) =>
      (ids || []).map(id => opts.fabFilesById?.[id]).filter(Boolean)
    );
    const getMostRecentChatHistory = vi.fn(async () => opts.recentMessages ?? []);
    const service = new ImageGenerationService({
      db: { fabFiles: { findAccessibleInIds }, quests: { getMostRecentChatHistory } },
    } as any);
    return { service, findAccessibleInIds, getMostRecentChatHistory };
  };

  const select = (
    service: ImageGenerationService,
    args: {
      model: string;
      supportsImageVariation: boolean;
      intent?: 'fresh' | 'continuation';
      fabFileIds?: string[];
      referenceImageFabFileIds?: string[];
      userId?: string;
      userGroups?: string[];
    }
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).selectInputImage({
      sessionId: 's1',
      fabFileIds: args.fabFileIds ?? [],
      referenceImageFabFileIds: args.referenceImageFabFileIds,
      userId: args.userId ?? 'u1',
      userGroups: args.userGroups,
      model: args.model,
      modelInfo: { supportsImageVariation: args.supportsImageVariation } as ModelInfo,
      intent: args.intent ?? 'fresh',
      logger: silentLogger,
    });

  it('resolves a Kontext input image from a user attachment earlier in the notebook (the bug)', async () => {
    // No workbench upload; the image the user attached to a prior message must be found so
    // Kontext (a required-input model) does not falsely report "no input image".
    const { service, findAccessibleInIds } = makeService({
      fabFilesById: { f1: cleanImage('f1') },
      recentMessages: [{ id: 'm1', type: 'message', timestamp: new Date(0), fabFileIds: ['f1'] }],
    });

    const result = await select(service, {
      model: ImageModels.FLUX_KONTEXT_PRO,
      supportsImageVariation: true,
      userId: 'u1',
      userGroups: ['g1'],
    });

    expect(result.fileImage?.id).toBe('f1');
    expect(result.imageSource).toBe('notebook_attachment');
    // Pin the SECOND (message-history) call site independently of the workbench call: the
    // notebook-attachment lookup must also run as the caller, with the same lakeAccess arg, so a
    // regression that drops the principal here can no longer be masked by the workbench call
    // satisfying a shared toHaveBeenCalledWith. Workbench call is #1 (empty ids), history is #2.
    expect(findAccessibleInIds).toHaveBeenNthCalledWith(2, ['f1'], { userId: 'u1', userGroups: ['g1'] }, undefined);
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

  it("denies another user's fabFileId - the scoped lookup drops it, so no image is selected", async () => {
    // The caller passes a workbench fabFileId that findAccessibleInIds does not return (not
    // owned by / shared with the caller). It must never be presigned or fed to the provider.
    const { service, findAccessibleInIds } = makeService({ fabFilesById: {} });
    const result = await select(service, {
      model: ImageModels.FLUX_KONTEXT_PRO,
      supportsImageVariation: true,
      fabFileIds: ['someone-elses-file'],
      userId: 'attacker',
      userGroups: ['g1'],
    });
    expect(result.fileImage).toBeUndefined();
    // Pin the workbench call exactly, third arg included: the scoped lookup runs as the caller
    // (never a widened principal) and threads the caller's lakeAccess (undefined here - no resolver
    // wired in this test), so the arm can never be silently dropped from the assertion.
    expect(findAccessibleInIds).toHaveBeenNthCalledWith(
      1,
      ['someone-elses-file'],
      { userId: 'attacker', userGroups: ['g1'] },
      undefined
    );
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

describe('ImageGenerationService.selectInputImage reference images (#2744)', () => {
  type FakeFile = { id: string; filePath: string; mimeType: string; moderationStatus: string };
  const cleanImage = (id: string): FakeFile => ({
    id,
    filePath: `fab/${id}.png`,
    mimeType: 'image/png',
    moderationStatus: 'clean',
  });

  const makeService = (fabFilesById: Record<string, Partial<FakeFile>>) => {
    const findAccessibleInIds = vi.fn(async (ids: string[]) =>
      (ids || []).map(id => fabFilesById?.[id]).filter(Boolean)
    );
    const service = new ImageGenerationService({
      db: { fabFiles: { findAccessibleInIds }, quests: { getMostRecentChatHistory: vi.fn(async () => []) } },
    } as any);
    return { service, findAccessibleInIds };
  };

  const select = (
    service: ImageGenerationService,
    args: { model: string; fabFileIds?: string[]; referenceImageFabFileIds?: string[] }
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).selectInputImage({
      sessionId: 's1',
      fabFileIds: args.fabFileIds ?? [],
      referenceImageFabFileIds: args.referenceImageFabFileIds,
      userId: 'u1',
      userGroups: ['g1'],
      model: args.model,
      modelInfo: { supportsImageVariation: true } as ModelInfo,
      intent: 'fresh',
      logger: silentLogger,
    });

  it('returns anchors in the order the caller listed them, not the repo order', async () => {
    // The repo returns whatever Mongo hands back; order is the caller's contract because
    // OpenAI binds a mask to element 0 and reads the rest positionally.
    const { service } = makeService({ a: cleanImage('a'), b: cleanImage('b'), c: cleanImage('c') });

    const result = await select(service, {
      model: ImageModels.GPT_IMAGE_2,
      referenceImageFabFileIds: ['c', 'a', 'b'],
    });

    expect(result.referenceImages.map((f: FakeFile) => f.id)).toEqual(['c', 'a', 'b']);
  });

  it("looks anchors up as the caller, so another user's file is never presigned", async () => {
    const { service, findAccessibleInIds } = makeService({ a: cleanImage('a') });

    await select(service, { model: ImageModels.GPT_IMAGE_2, referenceImageFabFileIds: ['a'] });

    expect(findAccessibleInIds).toHaveBeenCalledWith(['a'], { userId: 'u1', userGroups: ['g1'] }, undefined);
  });

  it('rejects an anchor the caller cannot access rather than silently rendering fewer', async () => {
    // Silently dropping would bill for an image the user did not describe, with nothing in
    // the response explaining why it looks wrong.
    const { service } = makeService({ a: cleanImage('a') });

    await expect(
      select(service, { model: ImageModels.GPT_IMAGE_2, referenceImageFabFileIds: ['a', 'nope'] })
    ).rejects.toThrow(/nope/);
  });

  it('rejects an anchor that is held or blocked by moderation', async () => {
    const { service } = makeService({ a: { ...cleanImage('a'), moderationStatus: 'blocked' } });

    await expect(select(service, { model: ImageModels.GPT_IMAGE_2, referenceImageFabFileIds: ['a'] })).rejects.toThrow(
      /moderation/
    );
  });

  it('rejects a non-image anchor', async () => {
    const { service } = makeService({ a: { ...cleanImage('a'), mimeType: 'application/pdf' } });

    await expect(select(service, { model: ImageModels.GPT_IMAGE_2, referenceImageFabFileIds: ['a'] })).rejects.toThrow(
      /not an image/
    );
  });

  it('rejects more anchors than the cap, which is what bounds the unbilled input cost', async () => {
    const { service } = makeService({});
    const tooMany = Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, i) => `f${i}`);

    await expect(
      select(service, { model: ImageModels.GPT_IMAGE_2, referenceImageFabFileIds: tooMany })
    ).rejects.toThrow(/At most/);
  });

  it('drops anchors for a non-gpt-image model instead of failing the render', async () => {
    // Only OpenAI's edit endpoint is wired for a multi-image array; BFL/Gemini would 400.
    const { service, findAccessibleInIds } = makeService({ a: cleanImage('a') });

    const result = await select(service, {
      model: ImageModels.FLUX_PRO_1_1,
      referenceImageFabFileIds: ['a'],
    });

    expect(result.referenceImages).toEqual([]);
    expect(findAccessibleInIds).not.toHaveBeenCalledWith(['a'], expect.anything(), expect.anything());
  });

  it('collapses a repeated anchor id instead of paying for the same image twice', async () => {
    // OpenAI bills input tokens per image in the array, and a repeat teaches the model
    // nothing new - so a duplicate is pure cost plus a wasted slot against the cap.
    const { service, findAccessibleInIds } = makeService({ a: cleanImage('a'), b: cleanImage('b') });

    const result = await select(service, {
      model: ImageModels.GPT_IMAGE_2,
      referenceImageFabFileIds: ['a', 'b', 'a'],
    });

    // First occurrence wins, so de-duplication cannot reorder what the caller asked for.
    expect(result.referenceImages.map((f: FakeFile) => f.id)).toEqual(['a', 'b']);
    expect(findAccessibleInIds).toHaveBeenCalledWith(['a', 'b'], expect.anything(), undefined);
  });

  it('counts the cap against unique ids, not raw array slots', async () => {
    const { service } = makeService(
      Object.fromEntries(Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => [`f${i}`, cleanImage(`f${i}`)]))
    );
    const ids = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => `f${i}`);

    const result = await select(service, {
      model: ImageModels.GPT_IMAGE_2,
      // One over the cap by raw length, exactly at it once de-duplicated.
      referenceImageFabFileIds: [...ids, ids[0]],
    });

    expect(result.referenceImages).toHaveLength(MAX_REFERENCE_IMAGES);
  });

  it('makes no extra lookup when no anchors are requested', async () => {
    const { service, findAccessibleInIds } = makeService({});

    const result = await select(service, { model: ImageModels.GPT_IMAGE_2 });

    expect(result.referenceImages).toEqual([]);
    // One call only: the workbench lookup. An unconditional second call would add a DB
    // roundtrip to every image generation.
    expect(findAccessibleInIds).toHaveBeenCalledTimes(1);
  });
});

describe('ImageGenerationService.invoke (image-parameter passthrough)', () => {
  // Regression: safety_tolerance, prompt_upsampling, seed, and output_format were undeclared on
  // GenerateImageIvokeParamsSchema, so Zod stripped them from parsedBody before `...rest` ever
  // reached the queue payload - the user's chosen values were silently replaced by schema defaults.
  const makeInvokeService = (startImageGenerationProcess: ReturnType<typeof vi.fn>) => {
    const findById = vi.fn(async () => ({ id: 'session1' }) as ISessionDocument);
    const create = vi.fn(async (input: any) => ({ id: 'quest1', ...input }));
    const update = vi.fn(async () => undefined);
    const getMostRecentChatHistory = vi.fn(async () => []);
    const questsFindById = vi.fn(async () => ({ id: 'quest1' }) as any);
    const service = new ImageGenerationService({
      db: {
        sessions: { findById },
        quests: { create, update, getMostRecentChatHistory, findById: questsFindById },
      },
      startImageGenerationProcess,
    } as any);
    return { service, create };
  };

  it('forwards the user-set safety_tolerance, prompt_upsampling, seed, and output_format to the queue payload', async () => {
    const startImageGenerationProcess = vi.fn(async () => undefined);
    const { service } = makeInvokeService(startImageGenerationProcess);

    await service.invoke({
      body: {
        sessionId: 'session1',
        prompt: 'a cat',
        model: ImageModels.FLUX_PRO_1_1,
        fabFileIds: [],
        safety_tolerance: 1,
        prompt_upsampling: true,
        seed: 42,
        output_format: 'jpeg',
      } as any,
      userId: 'user1',
    });

    expect(startImageGenerationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        safety_tolerance: 1,
        prompt_upsampling: true,
        seed: 42,
        output_format: 'jpeg',
      })
    );
  });

  it('drops a null seed/output_format from promptMeta.parameters instead of persisting null (breaks /api/feedback otherwise)', async () => {
    const startImageGenerationProcess = vi.fn(async () => undefined);
    const { service, create } = makeInvokeService(startImageGenerationProcess);

    await service.invoke({
      body: {
        sessionId: 'session1',
        prompt: 'a cat',
        model: ImageModels.FLUX_PRO_1_1,
        fabFileIds: [],
        seed: null,
        output_format: null,
      } as any,
      userId: 'user1',
    });

    const questInput = create.mock.calls[0][0];
    expect(questInput.promptMeta.model.parameters).not.toHaveProperty('seed');
    expect(questInput.promptMeta.model.parameters).not.toHaveProperty('output_format');
  });

  it('steps a gpt-image-2 selection down to gpt-image-1.5 when background is transparent', async () => {
    const startImageGenerationProcess = vi.fn(async () => undefined);
    const { service, create } = makeInvokeService(startImageGenerationProcess);

    await service.invoke({
      body: {
        sessionId: 'session1',
        prompt: 'a cutout icon',
        model: ImageModels.GPT_IMAGE_2,
        fabFileIds: [],
        background: 'transparent',
      } as any,
      userId: 'user1',
    });

    expect(startImageGenerationProcess).toHaveBeenCalledWith(
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5, background: 'transparent' })
    );
    const questInput = create.mock.calls[0][0];
    expect(questInput.promptMeta.model.name).toBe(ImageModels.GPT_IMAGE_1_5);
  });
});

describe('ImageGenerationService.process (Gemini provider-dispatch parameter passthrough)', () => {
  // process() passes safety_tolerance/prompt_upsampling/seed/output_format straight through to
  // geminiService.generate() - GeminiImageService.buildGenerationConfig() is the single place
  // that refuses to forward prompt_upsampling/seed to Google's API (see its own test suite),
  // since Google rejects the mere PRESENCE of those two fields. This test just confirms process()
  // isn't dropping anything before it gets there.
  const geminiModelInfo = {
    id: ImageModels.GEMINI_2_5_FLASH_IMAGE,
    type: 'image',
    name: ImageModels.GEMINI_2_5_FLASH_IMAGE,
    backend: ModelBackend.Gemini,
    contextWindow: 10000,
    max_tokens: 10000,
    supportsImageVariation: false,
    pricing: { 1: { input: 0, output: 0 } },
  } as unknown as ModelInfo;

  const makeProcessService = () => {
    const quest = { id: 'quest1', sessionId: 'session1', status: undefined as string | undefined };
    const findById = vi.fn(async () => quest as any);
    const update = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => undefined);
    const findAccessibleInIds = vi.fn(async () => []);
    const service = new ImageGenerationService({
      db: {
        quests: { findById, update, updateMany },
        users: { findById: vi.fn(async () => ({ id: 'user1', currentCredits: 1_000_000 })) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds },
      },
      logEvent: vi.fn().mockResolvedValue(undefined),
      abilityGetter: vi.fn().mockReturnValue({}),
      storage: {} as any,
      fabFileStorage: {} as any,
      wsHttpsUrl: 'https://ws.example.com',
    } as any);
    return service;
  };

  it('forwards safety_tolerance, prompt_upsampling, seed, and output_format to GeminiImageService.generate', async () => {
    vi.mocked(getAvailableModels).mockResolvedValue([geminiModelInfo]);
    mockGeminiGenerate.mockReset();
    mockGeminiGenerate.mockResolvedValue([]); // empty images short-circuits storage/moderation below

    const service = makeProcessService();

    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'a red bicycle',
        model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
        seed: 42,
        prompt_upsampling: true,
        safety_tolerance: 1,
        output_format: 'jpeg',
      } as any,
      logger: silentLogger,
    });

    expect(mockGeminiGenerate).toHaveBeenCalledWith(
      'a red bicycle',
      expect.objectContaining({
        seed: 42,
        prompt_upsampling: true,
        output_format: 'jpeg',
      })
    );
  });
});

describe('ImageGenerationService.process (Gemini edit-path model passthrough)', () => {
  // Regression: process()'s Gemini edit branch (fired on any continuation/edit turn - a workbench
  // image or carried-forward prior image) never passed `model` to geminiService.edit(), so it
  // silently ran on GeminiImageService's hardcoded default (GEMINI_2_5_FLASH_IMAGE) regardless of
  // which Gemini model the user actually selected. The sibling generate() call (fresh, no input
  // image) already passed model correctly - this only affected the edit path.
  const geminiModelInfo = {
    id: ImageModels.GEMINI_3_PRO_IMAGE,
    type: 'image',
    name: ImageModels.GEMINI_3_PRO_IMAGE,
    backend: ModelBackend.Gemini,
    contextWindow: 10000,
    max_tokens: 10000,
    supportsImageVariation: true,
    pricing: { 1: { input: 0, output: 0 } },
  } as unknown as ModelInfo;

  const makeEditService = () => {
    const quest = { id: 'quest1', sessionId: 'session1', status: undefined as string | undefined };
    const findById = vi.fn(async () => quest as any);
    const update = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => undefined);
    const findAccessibleInIds = vi.fn(async () => [
      { id: 'f1', filePath: 'data:image/png;base64,AAAA', mimeType: 'image/png', moderationStatus: 'clean' },
    ]);
    const service = new ImageGenerationService({
      db: {
        quests: { findById, update, updateMany },
        users: { findById: vi.fn(async () => ({ id: 'user1', currentCredits: 1_000_000 })) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds },
      },
      logEvent: vi.fn().mockResolvedValue(undefined),
      abilityGetter: vi.fn().mockReturnValue({}),
      storage: { upload: vi.fn().mockResolvedValue('generated/output.png') } as any,
      fabFileStorage: { getSignedUrl: vi.fn(async (path: string) => path) } as any,
      wsHttpsUrl: 'https://ws.example.com',
    } as any);
    return service;
  };

  it('forwards the selected model to GeminiImageService.edit on a continuation/edit turn', async () => {
    vi.mocked(getAvailableModels).mockResolvedValue([geminiModelInfo]);
    mockGeminiEdit.mockReset();
    mockGeminiEdit.mockResolvedValue({ type: 'success', dataUrl: 'data:image/png;base64,RESULT' });

    const service = makeEditService();

    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'make it blue',
        model: ImageModels.GEMINI_3_PRO_IMAGE,
        fabFileIds: ['f1'],
        intent: 'continuation',
      } as any,
      logger: silentLogger,
    });

    expect(mockGeminiEdit).toHaveBeenCalledWith(
      expect.any(String),
      'make it blue',
      expect.objectContaining({ model: ImageModels.GEMINI_3_PRO_IMAGE })
    );
  });
});

describe('ImageGenerationService.process (prompt truncation)', () => {
  // Regression: a catalog row reporting max_tokens: 0 made every prompt look over-cap, and the
  // truncation branch stringified the token id array - so the provider was asked to draw
  // "64 2579 24149" and dutifully rendered those numbers instead of an apple.
  const imageModelInfo = (max_tokens: number) =>
    ({
      id: ImageModels.GEMINI_2_5_FLASH_IMAGE,
      type: 'image',
      name: ImageModels.GEMINI_2_5_FLASH_IMAGE,
      backend: ModelBackend.Gemini,
      contextWindow: 10000,
      max_tokens,
      supportsImageVariation: false,
      pricing: { 1: { input: 0, output: 0 } },
    }) as unknown as ModelInfo;

  const runWithCap = async (max_tokens: number, prompt: string) => {
    vi.mocked(getAvailableModels).mockResolvedValue([imageModelInfo(max_tokens)]);
    mockGeminiGenerate.mockReset();
    mockGeminiGenerate.mockResolvedValue([]);

    const quest = { id: 'quest1', sessionId: 'session1', status: undefined as string | undefined };
    const service = new ImageGenerationService({
      db: {
        quests: { findById: vi.fn(async () => quest as any), update: vi.fn(), updateMany: vi.fn() },
        users: { findById: vi.fn(async () => ({ id: 'user1', currentCredits: 1_000_000 })) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds: vi.fn(async () => []) },
      },
      logEvent: vi.fn().mockResolvedValue(undefined),
      abilityGetter: vi.fn().mockReturnValue({}),
      storage: {} as any,
      fabFileStorage: {} as any,
      wsHttpsUrl: 'https://ws.example.com',
    } as any);

    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt,
        model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
      } as any,
      logger: silentLogger,
    });

    return mockGeminiGenerate.mock.calls[0][0] as string;
  };

  it('sends a short prompt verbatim when the catalog row reports max_tokens: 0', async () => {
    expect(await runWithCap(0, 'a red apple')).toBe('a red apple');
  });

  it('sends a short prompt verbatim under a sane cap', async () => {
    expect(await runWithCap(10000, 'a red apple')).toBe('a red apple');
  });

  it('sends real text, not token ids, when a genuinely long prompt is trimmed', async () => {
    const sent = await runWithCap(10000, 'a red apple on a wooden table '.repeat(2000));
    expect(sent).toContain('a red apple');
    // The old code emitted a space-separated list of token ids.
    expect(sent).not.toMatch(/(^|\s)\d+(\s|$)/);
  });
});

describe('ImageGenerationService.validateUserCredits (per-member cap)', () => {
  // GROK image quality has a flat usdCost, so requiredCredits is deterministic here.
  const modelInfo = { id: ImageModels.GROK_IMAGINE_IMAGE_QUALITY } as ModelInfo;
  const user = { id: 'user1', currentCredits: 1_000_000 } as any;
  const logger = { ...silentLogger, updateMetadata: vi.fn() } as unknown as Logger;
  const validate = (organization: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (new ImageGenerationService({ db: {} } as any) as any).validateUserCredits(
      user,
      modelInfo,
      1,
      {},
      logger,
      organization
    );

  it('throws when the member is over the org per-member cap even though the pool is funded', async () => {
    const organization = {
      id: 'org1',
      currentCredits: 1_000_000,
      maxCreditsPerMember: 500,
      userDetails: [{ id: 'user1', usedCredits: 1000 }],
    };
    await expect(validate(organization)).rejects.toThrow(/member credit limit/i);
  });

  it('allows a member who is still under the cap', async () => {
    const organization = {
      id: 'org1',
      currentCredits: 1_000_000,
      maxCreditsPerMember: 1_000_000,
      userDetails: [{ id: 'user1', usedCredits: 0 }],
    };
    await expect(validate(organization)).resolves.toMatchObject({ requiredCredits: expect.any(Number) });
  });

  it('does not gate when the org configures no per-member cap', async () => {
    const organization = {
      id: 'org1',
      currentCredits: 1_000_000,
      maxCreditsPerMember: null,
      userDetails: [{ id: 'user1', usedCredits: 999_999 }],
    };
    await expect(validate(organization)).resolves.toMatchObject({ requiredCredits: expect.any(Number) });
  });
});

describe('ImageGenerationService.process (GPT-Image omitted-quality pin)', () => {
  // #3007: a GPT-Image request that names no tier used to reach OpenAI with no `quality` at
  // all, so OpenAI applied its own 'auto' and could render at high effort - while the single,
  // never-reconciled credit hold had already been taken at the medium price. process() now
  // forwards the tier it bills. These assert the dispatch half; the billing half (unchanged)
  // is pinned in OpenAIImageCostCalculator.test.ts.
  const gptImageModelInfo = {
    id: ImageModels.GPT_IMAGE_2,
    type: 'image',
    name: ImageModels.GPT_IMAGE_2,
    backend: ModelBackend.OpenAI,
    contextWindow: 10000,
    max_tokens: 10000,
    supportsImageVariation: false,
    pricing: { 1: { input: 0, output: 0 } },
  } as unknown as ModelInfo;

  const makeProcessService = () => {
    const quest = { id: 'quest1', sessionId: 'session1', status: undefined as string | undefined };
    return new ImageGenerationService({
      db: {
        quests: { findById: vi.fn(async () => quest as any), update: vi.fn(), updateMany: vi.fn() },
        users: { findById: vi.fn(async () => ({ id: 'user1', currentCredits: 1_000_000 })) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds: vi.fn(async () => []) },
      },
      logEvent: vi.fn().mockResolvedValue(undefined),
      abilityGetter: vi.fn().mockReturnValue({}),
      storage: {} as any,
      fabFileStorage: {} as any,
      wsHttpsUrl: 'https://ws.example.com',
    } as any);
  };

  const generateWith = async (quality?: string) => {
    vi.mocked(getAvailableModels).mockResolvedValue([gptImageModelInfo]);
    mockGeminiGenerate.mockReset();
    mockGeminiGenerate.mockResolvedValue([]); // empty images short-circuits storage/moderation

    await makeProcessService().process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'a red bicycle',
        model: ImageModels.GPT_IMAGE_2,
        size: '1024x1024',
        ...(quality ? { quality } : {}),
      } as any,
      logger: silentLogger,
    });

    return mockGeminiGenerate.mock.calls[0]?.[1];
  };

  it('forwards the billed tier when the request names no quality', async () => {
    expect(await generateWith()).toMatchObject({ quality: OMITTED_QUALITY_TIER });
  });

  it('bills and renders an omitted quality at the same tier', async () => {
    const omitted = await generateWith();
    const explicit = await generateWith(OMITTED_QUALITY_TIER);

    expect(omitted.quality).toBe(explicit.quality);
  });

  // 'auto' is the opt-in escape hatch the pin leaves open: it reaches OpenAI unresolved and is
  // priced at the ceiling (PR #2977). Pinning it here would silently downgrade that render.
  it('leaves an explicit "auto" unresolved for OpenAI to choose', async () => {
    expect(await generateWith('auto')).toMatchObject({ quality: 'auto' });
  });

  it.each(['low', 'high'])('leaves an explicit %s tier alone', async quality => {
    expect(await generateWith(quality)).toMatchObject({ quality });
  });
});
