import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService } from './ImageGeneration';
import { SUMMARIZATION_CONFIG } from './ChatCompletionFeatures';
import { ImageModels, ModelBackend, type ISessionDocument, type ModelInfo } from '@bike4mind/common';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn() };
});

vi.mock('../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../apiKeyService')>();
  return { ...actual, getEffectiveLLMApiKeys: vi.fn(async () => ({ gemini: 'gemini-key' })) };
});

const mockGeminiGenerate = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    aiImageService: vi.fn(() => ({ generate: mockGeminiGenerate })),
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
    const findAllInIds = vi.fn(async () => []);
    const service = new ImageGenerationService({
      db: {
        quests: { findById, update, updateMany },
        users: { findById: vi.fn(async () => ({ id: 'user1', currentCredits: 1_000_000 })) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAllInIds },
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
        fabFiles: { findAllInIds: vi.fn(async () => []) },
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
