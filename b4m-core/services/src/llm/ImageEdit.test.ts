import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ImageModels,
  IMAGES_PER_EDIT_REQUEST,
  ModelBackend,
  type IUserDocument,
  type ModelInfo,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { aiImageService, getSettingsValue } from '@bike4mind/utils';
import { estimateImageCredits } from '../imageCost';
import { ImageEditService } from './ImageEdit';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn() };
});

vi.mock('../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../apiKeyService')>();
  return {
    ...actual,
    getEffectiveLLMApiKeys: vi.fn(async () => ({ bfl: 'bfl-key', openai: 'openai-key', gemini: 'gemini-key' })),
  };
});

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    aiImageService: vi.fn(),
    getSettingsMap: vi.fn(async () => ({})),
    getSettingsValue: vi.fn(() => undefined),
    ClientMessageSender: class {
      sendToClient = vi.fn();
    },
  };
});

vi.mock('./questHeartbeat', () => ({ startQuestHeartbeat: vi.fn(async () => () => {}) }));

vi.mock('axios', () => ({
  default: { get: vi.fn(async () => ({ data: Buffer.from('image-bytes') })) },
}));

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as unknown as Logger;

const makeModelInfo = (id: string): ModelInfo =>
  ({
    id,
    type: 'image',
    name: id,
    backend: ModelBackend.BFL,
    contextWindow: 10000,
    max_tokens: 10000,
    pricing: { 1: { input: 0, output: 0 } },
  }) as unknown as ModelInfo;

const kontextPro = makeModelInfo(ImageModels.FLUX_KONTEXT_PRO);
const unsupportedImageModel = makeModelInfo('made-up-image-model');
const gptImage = makeModelInfo(ImageModels.GPT_IMAGE_1_5);

const richUser = { id: 'user1', currentCredits: 1_000_000 } as unknown as IUserDocument;

const validate = (
  model: string,
  imageParams: { size?: string; quality?: 'low' | 'medium' | 'high' } = {}
): Promise<{ requiredCredits: number; usdCost: number }> => {
  const service = new ImageEditService({ db: {} } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).validateUserCredits(richUser, model, imageParams, silentLogger, null);
};

describe('ImageEditService.validateUserCredits', () => {
  beforeEach(() => {
    vi.mocked(getAvailableModels).mockResolvedValue([kontextPro, unsupportedImageModel, gptImage]);
  });

  it('bills one image, the number this path renders, not a flat 1 credit', async () => {
    const actual = await validate(ImageModels.FLUX_KONTEXT_PRO);

    expect(actual.requiredCredits).toBeGreaterThan(1);
    expect(actual).toEqual(estimateImageCredits(kontextPro, IMAGES_PER_EDIT_REQUEST, { model: kontextPro.id }));
  });

  it('matches estimateImageCredits so the preview and the charge agree', async () => {
    const input = { model: ImageModels.FLUX_KONTEXT_PRO, size: '1024x1024' };
    const expected = estimateImageCredits(kontextPro, IMAGES_PER_EDIT_REQUEST, input);

    const actual = await validate(ImageModels.FLUX_KONTEXT_PRO, { size: '1024x1024' });

    expect(actual.requiredCredits).toBe(expected.requiredCredits);
    expect(actual.usdCost).toBe(expected.usdCost);
  });

  it('surfaces "Model not supported" for an image model with no cost calculator', async () => {
    await expect(validate('made-up-image-model')).rejects.toThrow('Model not supported');
  });

  it('bills a GPT-Image model at the requested tier - high costs more than low', async () => {
    const low = await validate(ImageModels.GPT_IMAGE_1_5, { quality: 'low' });
    const high = await validate(ImageModels.GPT_IMAGE_1_5, { quality: 'high' });

    expect(high.requiredCredits).toBeGreaterThan(low.requiredCredits);
  });

  it('still rejects a model that is not in the available list', async () => {
    await expect(validate('not-available-at-all')).rejects.toThrow('Invalid model');
  });
});

describe('ImageEditService.process model dispatch', () => {
  const editSpy = vi.fn();

  const makeService = (dbExtra: Record<string, unknown> = {}) => {
    const quest = {
      id: 'quest1',
      sessionId: 'session1',
      status: undefined as string | undefined,
      type: 'message',
      reply: undefined as string | undefined,
      replies: [],
      images: [],
    };
    const service = new ImageEditService({
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => quest), update: vi.fn(async () => quest) },
        users: { findById: vi.fn(async () => richUser) },
        organizations: { findById: vi.fn(async () => null) },
        ...dbExtra,
        fabFiles: {
          findAllInIds: vi.fn(async () => [
            {
              id: 'mask1',
              fileName: 'image_mask_1.png',
              mimeType: 'image/png',
              filePath: 'masks/mask1.png',
              moderationStatus: 'clean',
            },
          ]),
        },
      },
      startImageEditProcess: vi.fn(),
      deleteFabFile: vi.fn(),
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: {} as never,
      fabFileStorage: { getSignedUrl: vi.fn(async () => 'https://example.invalid/mask.png') } as never,
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).tokenizer = {
      encodeTokens: vi.fn(async () => [1, 2, 3]),
      decodeTokens: vi.fn(async () => 'make it blue'),
    };
    return { service, quest };
  };

  const run = async (model: string, bodyOverride: Record<string, unknown> = {}, dbExtra?: Record<string, unknown>) => {
    const { service, quest } = makeService(dbExtra);
    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'make it blue',
        model,
        image: 'https://example.invalid/source.png',
        fabFileIds: ['mask1'],
        ...bodyOverride,
      } as never,
      logger: silentLogger,
    });
    return quest;
  };

  beforeEach(() => {
    editSpy.mockReset();
    // Stop right after dispatch: the assertion is about which model reached the provider,
    // not about storing the result.
    editSpy.mockRejectedValue(new Error('stop-after-dispatch'));
    vi.mocked(aiImageService).mockClear();
    vi.mocked(aiImageService).mockReturnValue({ edit: editSpy } as never);
    vi.mocked(getAvailableModels).mockResolvedValue([]);
  });

  it('sends the selected BFL model to BFL instead of a hardcoded one', async () => {
    await run(ImageModels.FLUX_PRO_FILL);

    expect(vi.mocked(aiImageService).mock.calls[0][0]).toBe('bfl');
    expect(editSpy.mock.calls[0][2]).toMatchObject({ model: ImageModels.FLUX_PRO_FILL });
  });

  it('sends the selected OpenAI model instead of defaulting to gpt-image-1', async () => {
    await run(ImageModels.GPT_IMAGE_1_5);

    expect(vi.mocked(aiImageService).mock.calls[0][0]).toBe('openai');
    expect(editSpy.mock.calls[0][2]).toMatchObject({ model: ImageModels.GPT_IMAGE_1_5 });
  });

  it('routes a Gemini selection to Gemini rather than OpenAI', async () => {
    await run(ImageModels.GEMINI_2_5_FLASH_IMAGE);

    expect(vi.mocked(aiImageService).mock.calls[0][0]).toBe('gemini');
    expect(editSpy.mock.calls[0][2]).toMatchObject({ model: ImageModels.GEMINI_2_5_FLASH_IMAGE });
  });

  it('forwards the requested quality to the OpenAI edit service', async () => {
    await run(ImageModels.GPT_IMAGE_1_5, { quality: 'high' });

    expect(editSpy.mock.calls[0][2]).toMatchObject({ model: ImageModels.GPT_IMAGE_1_5, quality: 'high' });
  });

  it('forwards background and output_format to the OpenAI edit service', async () => {
    await run(ImageModels.GPT_IMAGE_1_5, { background: 'transparent', output_format: 'png' });

    expect(editSpy.mock.calls[0][2]).toMatchObject({
      model: ImageModels.GPT_IMAGE_1_5,
      background: 'transparent',
      output_format: 'png',
    });
  });

  it('steps a gpt-image-2 selection down to gpt-image-1.5 when background is transparent', async () => {
    await run(ImageModels.GPT_IMAGE_2, { background: 'transparent', output_format: 'png' });

    expect(editSpy.mock.calls[0][2]).toMatchObject({
      model: ImageModels.GPT_IMAGE_1_5,
      background: 'transparent',
    });
  });

  it('rejects a model that cannot edit instead of silently substituting one', async () => {
    const quest = await run(ImageModels.FLUX_KONTEXT_PRO);

    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.type).toBe('error');
    expect(quest.reply).toContain('does not support image editing');
  });

  it('rejects an XAI selection, which has no edit endpoint at all', async () => {
    const quest = await run(ImageModels.GROK_IMAGINE_IMAGE_QUALITY);

    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.type).toBe('error');
    expect(quest.reply).toContain('does not support image editing');
  });

  describe('credits charged vs images rendered', () => {
    // Enforcement is off in the dispatch cases above; these need the credit branch to run.
    const runBilled = (bodyOverride: Record<string, unknown>) =>
      run(ImageModels.GPT_IMAGE_1_5, bodyOverride, { creditTransactions: { create: vi.fn() } });

    beforeEach(() => {
      vi.mocked(getAvailableModels).mockResolvedValue([gptImage]);
      vi.mocked(getSettingsValue).mockImplementation(name => name === 'enforceCredits' || undefined);
    });

    // Nothing resets this mock globally, so leave enforcement off for whatever runs next.
    afterEach(() => {
      vi.mocked(getSettingsValue).mockImplementation(() => undefined);
    });

    it('bills a multi-image request the same as a single one, since only one image renders', async () => {
      const single = await runBilled({ n: 1 });
      const many = await runBilled({ n: 5 });

      expect(single.creditsUsed).toBeGreaterThan(0);
      expect(many.creditsUsed).toBe(single.creditsUsed);
      // Both dispatched exactly once, and edit() resolves to a single-image ImageEditResponse,
      // so the charge above is for the one image the caller actually gets back.
      expect(editSpy).toHaveBeenCalledTimes(2);
    });

    it('does not offer the provider an image count it would render and we would discard', async () => {
      await runBilled({ n: 5 });

      expect(editSpy.mock.calls[0][2]).not.toHaveProperty('n');
    });
  });
});

describe('ImageEditService.process reference images (#2744)', () => {
  const editSpy = vi.fn();
  const cleanImage = (id: string) => ({
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    filePath: `fab/${id}.png`,
    moderationStatus: 'clean',
  });

  const run = async (
    bodyOverride: Record<string, unknown>,
    opts: { accessible?: Record<string, unknown>; model?: string } = {}
  ) => {
    const accessible = opts.accessible ?? { a: cleanImage('a'), b: cleanImage('b') };
    const findAccessibleInIds = vi.fn(async (ids: string[]) => (ids || []).map(id => accessible[id]).filter(Boolean));
    const resolveLakeAccess = vi.fn(async () => ({}) as never);
    const quest = {
      id: 'quest1',
      sessionId: 'session1',
      status: undefined as string | undefined,
      type: 'message',
      reply: undefined as string | undefined,
      replies: [],
      images: [],
    };
    const service = new ImageEditService({
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => quest), update: vi.fn(async () => quest) },
        users: { findById: vi.fn(async () => richUser) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: {
          findAllInIds: vi.fn(async () => []),
          findAccessibleInIds,
        },
      },
      startImageEditProcess: vi.fn(),
      deleteFabFile: vi.fn(),
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: {} as never,
      fabFileStorage: { getSignedUrl: vi.fn(async (path: string) => `https://example.invalid/${path}`) } as never,
      resolveLakeAccess,
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).tokenizer = {
      encodeTokens: vi.fn(async () => [1, 2, 3]),
      decodeTokens: vi.fn(async () => 'make it blue'),
    };
    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'make it blue',
        model: opts.model ?? ImageModels.GPT_IMAGE_1_5,
        image: 'https://example.invalid/source.png',
        fabFileIds: [],
        ...bodyOverride,
      } as never,
      logger: silentLogger,
    });
    return { quest, findAccessibleInIds, resolveLakeAccess };
  };

  beforeEach(() => {
    editSpy.mockReset();
    editSpy.mockRejectedValue(new Error('stop-after-dispatch'));
    vi.mocked(aiImageService).mockClear();
    vi.mocked(aiImageService).mockReturnValue({ edit: editSpy } as never);
    vi.mocked(getAvailableModels).mockResolvedValue([]);
  });

  it('forwards signed anchor URLs in the caller-supplied order', async () => {
    await run({ referenceImageFabFileIds: ['b', 'a'] });

    expect(editSpy.mock.calls[0][2].referenceImages).toEqual([
      'https://example.invalid/fab/b.png',
      'https://example.invalid/fab/a.png',
    ]);
  });

  it('scopes the anchor lookup to the caller, unlike the legacy unscoped mask lookup', async () => {
    // findAllInIds (still used for the mask) ignores the principal entirely; anchors must
    // not inherit that, or naming an id would read any user's file.
    const { findAccessibleInIds } = await run({ referenceImageFabFileIds: ['a'] });

    // Third arg is the resolved lake access, which must reach the lookup too - a lake-only
    // anchor the workbench admitted has to resolve here or it would 400 as inaccessible.
    expect(findAccessibleInIds).toHaveBeenCalledWith(['a'], { userId: 'user1', userGroups: undefined }, {});
  });

  it('fails the quest when an anchor is not accessible, rather than rendering fewer', async () => {
    const { quest } = await run({ referenceImageFabFileIds: ['a', 'ghost'] });

    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.type).toBe('error');
    expect(quest.reply).toContain('ghost');
  });

  it('sends no anchors to a provider that cannot carry them', async () => {
    await run({ referenceImageFabFileIds: ['a'] }, { model: ImageModels.GEMINI_2_5_FLASH_IMAGE });

    expect(vi.mocked(aiImageService).mock.calls[0][0]).toBe('gemini');
    expect(editSpy.mock.calls[0][2]).not.toHaveProperty('referenceImages');
  });

  it('sends an empty anchor list when none are requested', async () => {
    await run({});

    expect(editSpy.mock.calls[0][2].referenceImages).toEqual([]);
  });

  it('collapses a repeated anchor id instead of paying for the same image twice', async () => {
    await run({ referenceImageFabFileIds: ['a', 'b', 'a'] });

    // First occurrence wins, so de-duplication cannot reorder what the caller asked for.
    expect(editSpy.mock.calls[0][2].referenceImages).toEqual([
      'https://example.invalid/fab/a.png',
      'https://example.invalid/fab/b.png',
    ]);
  });

  it('resolves lake access only when anchors were actually requested', async () => {
    // The mask-only edit is the mainline and had no lake roundtrip before this feature;
    // anchors are the only thing on this path that needs the lake arms.
    const withoutAnchors = await run({});
    expect(withoutAnchors.resolveLakeAccess).not.toHaveBeenCalled();

    const withAnchors = await run({ referenceImageFabFileIds: ['a'] });
    expect(withAnchors.resolveLakeAccess).toHaveBeenCalledTimes(1);
  });
});

describe('ImageEditService.validateUserCredits (per-member cap)', () => {
  beforeEach(() => {
    vi.mocked(getAvailableModels).mockResolvedValue([kontextPro, unsupportedImageModel]);
  });

  const validateWithOrg = (organization: unknown) => {
    const service = new ImageEditService({ db: {} } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).validateUserCredits(richUser, ImageModels.FLUX_KONTEXT_PRO, {}, silentLogger, organization);
  };

  it('throws when the member is over the org per-member cap even though the pool is funded', async () => {
    await expect(
      validateWithOrg({
        id: 'org1',
        currentCredits: 1_000_000,
        maxCreditsPerMember: 5,
        userDetails: [{ id: 'user1', usedCredits: 1000 }],
      })
    ).rejects.toThrow(/member credit limit/i);
  });

  it('allows a member who is still under the cap', async () => {
    await expect(
      validateWithOrg({
        id: 'org1',
        currentCredits: 1_000_000,
        maxCreditsPerMember: 1_000_000,
        userDetails: [{ id: 'user1', usedCredits: 0 }],
      })
    ).resolves.toMatchObject({ requiredCredits: expect.any(Number) });
  });
});
