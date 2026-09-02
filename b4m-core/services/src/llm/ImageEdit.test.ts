import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageModels, ModelBackend, type IUserDocument, type ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { aiImageService } from '@bike4mind/utils';
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

const richUser = { id: 'user1', currentCredits: 1_000_000 } as unknown as IUserDocument;

const validate = (
  n: number,
  model: string,
  imageParams: { size?: string; quality?: 'low' | 'medium' | 'high' } = {}
): Promise<{ requiredCredits: number; usdCost: number }> => {
  const service = new ImageEditService({ db: {} } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).validateUserCredits(richUser, model, n, imageParams, silentLogger, null);
};

describe('ImageEditService.validateUserCredits', () => {
  beforeEach(() => {
    vi.mocked(getAvailableModels).mockResolvedValue([kontextPro, unsupportedImageModel]);
  });

  it('scales with n instead of billing a flat 1 credit', async () => {
    const one = await validate(1, ImageModels.FLUX_KONTEXT_PRO);
    const three = await validate(3, ImageModels.FLUX_KONTEXT_PRO);

    expect(one.requiredCredits).toBeGreaterThan(1);
    expect(three.usdCost).toBe(one.usdCost * 3);
    // Credits round UP (usdToCredits ceils), so 3 images can land one credit
    // above 3x a single image; the USD cost above carries the exact ratio.
    expect(three.requiredCredits - one.requiredCredits * 3).toBeLessThanOrEqual(1);
    expect(three.requiredCredits).toBeGreaterThanOrEqual(one.requiredCredits * 3);
  });

  it('matches estimateImageCredits so the preview and the charge agree', async () => {
    const input = { model: ImageModels.FLUX_KONTEXT_PRO, size: '1024x1024' };
    const expected = estimateImageCredits(kontextPro, 2, input);

    const actual = await validate(2, ImageModels.FLUX_KONTEXT_PRO, { size: '1024x1024' });

    expect(actual.requiredCredits).toBe(expected.requiredCredits);
    expect(actual.usdCost).toBe(expected.usdCost);
  });

  it('surfaces "Model not supported" for an image model with no cost calculator', async () => {
    await expect(validate(1, 'made-up-image-model')).rejects.toThrow('Model not supported');
  });

  it('still rejects a model that is not in the available list', async () => {
    await expect(validate(1, 'not-available-at-all')).rejects.toThrow('Invalid model');
  });
});

describe('ImageEditService.process model dispatch', () => {
  const editSpy = vi.fn();

  const makeService = () => {
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

  const run = async (model: string) => {
    const { service, quest } = makeService();
    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'make it blue',
        model,
        image: 'https://example.invalid/source.png',
        fabFileIds: ['mask1'],
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
});

describe('ImageEditService.validateUserCredits (per-member cap)', () => {
  beforeEach(() => {
    vi.mocked(getAvailableModels).mockResolvedValue([kontextPro, unsupportedImageModel]);
  });

  const validateWithOrg = (organization: unknown) => {
    const service = new ImageEditService({ db: {} } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).validateUserCredits(
      richUser,
      ImageModels.FLUX_KONTEXT_PRO,
      1,
      {},
      silentLogger,
      organization
    );
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
