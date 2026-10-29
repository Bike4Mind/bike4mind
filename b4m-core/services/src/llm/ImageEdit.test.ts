import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { z } from 'zod';
import {
  CREDITS_PER_USD_COST,
  CreditHolderType,
  EditImageRequestBodySchema,
  ImageModels,
  IMAGES_PER_EDIT_REQUEST,
  insufficientCreditsError,
  ModelBackend,
  type IUserDocument,
  type ModelInfo,
} from '@bike4mind/common';
import { silentLogger } from '../__tests__/utils/testUtils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { aiImageService, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { estimateImageCredits } from '../imageCost';
import { ImageEditService, type ImageEditBody } from './ImageEdit';
import type { SaveGeneratedAssetFn } from './saveGeneratedImage';

// The real stochastic rounding, with its draw pinned so the final debit is assertable.
const { settlementDraw } = vi.hoisted(() => ({ settlementDraw: vi.fn(() => 0.5) }));
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => settlementDraw()),
  };
});
beforeEach(() => {
  settlementDraw.mockReturnValue(0.5);
});

// What a draw of 0.5 settles for an exact USD cost: the floor, plus 1 when the fraction exceeds the draw.
const settledAtHalf = (usdCost: number) => {
  const raw = usdCost * CREDITS_PER_USD_COST;
  return Math.floor(raw) + (0.5 < raw - Math.floor(raw) ? 1 : 0);
};

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
    // The SSRF-guarded fetch is unit-tested in @bike4mind/utils; stubbed here so these dispatch
    // tests neither resolve DNS nor need a fake HTTP response shaped like a real axios one.
    downloadImageAsBuffer: vi.fn(async () => Buffer.from('image-bytes')),
    getSettingsMap: vi.fn(async () => ({})),
    getSettingsValue: vi.fn(() => undefined),
    ClientMessageSender: class {
      sendToClient = vi.fn();
    },
  };
});

vi.mock('./imageModerationGate', () => ({ moderateImageOrThrow: vi.fn(async () => undefined) }));

vi.mock('./questHeartbeat', async importOriginal => ({
  ...(await importOriginal<typeof import('./questHeartbeat')>()),
  startQuestHeartbeat: vi.fn(async () => () => {}),
}));

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

// A fake ImageCreditHolds port: hold reserves the estimate, settle keeps the draw, release is a no-op.
const makeCreditHolds = () => ({
  hold: vi.fn(async (params: { userId: string; organizationId: string | null; requiredCredits: number }) => ({
    ownerId: params.organizationId ?? params.userId,
    ownerType: params.organizationId ? CreditHolderType.Organization : CreditHolderType.User,
    userId: params.userId,
    organizationId: params.organizationId,
    reservedCredits: params.requiredCredits,
    balanceAfterHold: 0,
  })),
  settle: vi.fn(async (_hold: unknown, chargedCredits: number) => chargedCredits),
  release: vi.fn(async () => undefined),
});

const validate = (
  model: string,
  imageParams: { size?: string; quality?: 'low' | 'medium' | 'high' } = {}
): Promise<{ requiredCredits: number; usdCost: number }> => {
  const service = new ImageEditService({ db: {} } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).estimateCredits(richUser.id, model, imageParams);
};

describe('ImageEditService.estimateCredits', () => {
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

  const makeService = (
    dbExtra: Record<string, unknown> = {},
    // In production this enqueues; pass one that calls process() to drive invoke() end to end.
    startImageEditProcess: (body: ImageEditBody) => Promise<void> = vi.fn(),
    settledCredits?: number,
    assertModelAdmission: (userId: string, modelId: string) => Promise<void> = async () => {}
  ) => {
    const quest = {
      id: 'quest1',
      sessionId: 'session1',
      status: undefined as string | undefined,
      type: 'message',
      reply: undefined as string | undefined,
      replies: [],
      images: [],
    };
    const creditHolds = makeCreditHolds();
    if (settledCredits !== undefined) creditHolds.settle.mockResolvedValueOnce(settledCredits);
    const service = new ImageEditService({
      assertModelAdmission,
      creditHolds,
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => quest), update: vi.fn(async () => quest) },
        users: { findById: vi.fn(async () => richUser) },
        organizations: { findById: vi.fn(async () => null) },
        ...dbExtra,
        fabFiles: {
          findAccessibleInIds: vi.fn(async () => [
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
      startImageEditProcess,
      deleteFabFile: vi.fn(),
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: { upload: vi.fn(async () => 'edits/result.png') } as never,
      fabFileStorage: { getSignedUrl: vi.fn(async () => 'https://example.invalid/mask.png') } as never,
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).tokenizer = {
      encodeTokens: vi.fn(async () => [1, 2, 3]),
      decodeTokens: vi.fn(async () => 'make it blue'),
    };
    return { service, quest, creditHolds };
  };

  const run = async (
    model: string,
    bodyOverride: Record<string, unknown> = {},
    dbExtra?: Record<string, unknown>,
    settledCredits?: number
  ) => {
    const { service, quest, creditHolds } = makeService(dbExtra, undefined, settledCredits);
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
    return Object.assign(quest, { creditHolds });
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

  it('passes skipCache once per edit so an admin toggle applies on the next edit', async () => {
    vi.mocked(getSettingsMap).mockClear();

    try {
      await run(ImageModels.GPT_IMAGE_2);
    } catch {
      // The beforeEach edit spy rejects to stop after dispatch; the read happened before that.
    }

    const calls = vi.mocked(getSettingsMap).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toEqual({ skipCache: true });
  });

  it('sends the selected BFL model to BFL instead of a hardcoded one', async () => {
    await run(ImageModels.FLUX_PRO_FILL);

    expect(vi.mocked(aiImageService).mock.calls[0][0]).toBe('bfl');
    expect(editSpy.mock.calls[0][2]).toMatchObject({ model: ImageModels.FLUX_PRO_FILL });
  });

  it('refuses a queued paid-only edit before holding credits or calling the provider', async () => {
    const assertAdmission = vi.fn(async () => {
      throw new Error('paid plan required');
    });
    const { service, creditHolds } = makeService({}, undefined, undefined, assertAdmission);
    await service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        prompt: 'edit',
        model: ImageModels.GPT_IMAGE_1_5,
        image: 'https://example.invalid/image.png',
        fabFileIds: ['mask1'],
      } as never,
      logger: silentLogger,
    });
    expect(assertAdmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), ImageModels.GPT_IMAGE_1_5, undefined);
    expect(creditHolds.hold).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();
  });

  it('refuses a paid-only edit before enqueueing and gates the remapped model', async () => {
    const refusal = new Error('paid plan required');
    const assertAdmission = vi.fn(async () => {
      throw refusal;
    });
    const enqueue = vi.fn();
    const { service } = makeService({}, enqueue, undefined, assertAdmission);
    await expect(
      service.invoke({
        userId: 'user1',
        body: {
          sessionId: 'session1',
          questId: 'quest1',
          prompt: 'edit',
          model: ImageModels.GPT_IMAGE_2,
          background: 'transparent',
          image: 'https://example.invalid/image.png',
          fabFileIds: ['mask1'],
        },
      })
    ).rejects.toBe(refusal);
    expect(assertAdmission).toHaveBeenCalledWith('user1', ImageModels.GPT_IMAGE_1_5, undefined);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('carries a client-sent seed through invoke() to the BFL edit call', async () => {
    // Goes through invoke() because its EditImageRequestBodySchema parse is what used to strip seed.
    const serviceRef: { current?: ImageEditService } = {};
    const assertAdmission = vi.fn(async () => {});
    const { service } = makeService(
      {},
      body => serviceRef.current!.process({ body, logger: silentLogger }),
      undefined,
      assertAdmission
    );
    serviceRef.current = service;

    const body: z.infer<typeof EditImageRequestBodySchema> = {
      sessionId: 'session1',
      questId: 'quest1',
      prompt: 'make it blue',
      model: ImageModels.FLUX_PRO_FILL,
      image: 'https://example.invalid/source.png',
      fabFileIds: ['mask1'],
      seed: 12345,
    };
    await service.invoke({ body, userId: 'user1', adminRoleWithheld: true });
    expect(assertAdmission).toHaveBeenNthCalledWith(1, 'user1', ImageModels.FLUX_PRO_FILL, true);
    expect(assertAdmission).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'user1' }), ImageModels.FLUX_PRO_FILL, true);

    expect(editSpy.mock.calls[0][2]).toMatchObject({ seed: 12345 });
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

    it('holds the primary image plus each unique reference as input images', async () => {
      const plain = await runBilled({});
      const withRefs = await runBilled({ referenceImageFabFileIds: ['a', 'a', 'b'] });

      // Dispatch is stubbed to fail, so nothing settles: creditsUsed is still the round-up the gate held.
      expect(plain.creditsUsed).toBe(
        estimateImageCredits(gptImage, IMAGES_PER_EDIT_REQUEST, { model: gptImage.id, inputImageCount: 1 })
          .requiredCredits
      );
      expect(withRefs.creditsUsed).toBe(
        estimateImageCredits(gptImage, IMAGES_PER_EDIT_REQUEST, { model: gptImage.id, inputImageCount: 3 })
          .requiredCredits
      );
      expect(withRefs.creditsUsed).toBeGreaterThan(plain.creditsUsed as number);
    });

    it('holds against the personal account without an organization, the organization otherwise', async () => {
      const personal = await runBilled({});
      expect(personal.creditHolds.hold).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user1', organizationId: null, featureLabel: 'image editing' })
      );

      const organizational = await run(
        ImageModels.GPT_IMAGE_1_5,
        { organizationId: 'org1' },
        {
          creditTransactions: { create: vi.fn() },
          organizations: { findById: vi.fn(async (id: string) => ({ id })) },
        }
      );
      expect(organizational.creditHolds.hold).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user1', organizationId: 'org1' })
      );
    });

    it('ends the quest with insufficient_credits and never calls the provider when the hold is refused', async () => {
      const { service, quest, creditHolds } = makeService({ creditTransactions: { create: vi.fn() } });
      creditHolds.hold.mockRejectedValueOnce(insufficientCreditsError('Not enough credits.'));

      await service.process({
        body: {
          sessionId: 'session1',
          questId: 'quest1',
          userId: 'user1',
          prompt: 'make it blue',
          model: ImageModels.GPT_IMAGE_1_5,
          image: 'https://example.invalid/source.png',
          fabFileIds: ['mask1'],
        } as never,
        logger: silentLogger,
      });

      expect(quest.status).toBe('done');
      expect(vi.mocked(service['db'].quests.update)).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'done', errorCode: 'insufficient_credits' })
      );
      expect(editSpy).not.toHaveBeenCalled();
      expect(creditHolds.release).not.toHaveBeenCalled();
      expect(creditHolds.settle).not.toHaveBeenCalled();
    });

    it('releases the hold and never settles when the provider call rejects after the hold', async () => {
      const quest = await runBilled({});

      expect(quest.creditHolds.hold).toHaveBeenCalledTimes(1);
      const hold = await quest.creditHolds.hold.mock.results[0]?.value;
      expect(quest.creditHolds.release).toHaveBeenCalledTimes(1);
      expect(quest.creditHolds.release).toHaveBeenCalledWith(
        hold,
        expect.objectContaining({ featureLabel: 'image editing' })
      );
      expect(quest.creditHolds.settle).not.toHaveBeenCalled();
    });

    it('does not offer the provider an image count it would render and we would discard', async () => {
      await runBilled({ n: 5 });

      expect(editSpy.mock.calls[0][2]).not.toHaveProperty('n');
    });
  });

  describe('usage event on a charged edit', () => {
    const runCharged = (record: ReturnType<typeof vi.fn>, settledCredits?: number) =>
      run(
        ImageModels.GPT_IMAGE_1_5,
        {},
        { creditTransactions: { create: vi.fn() }, usageEvents: { record } },
        settledCredits
      );

    beforeEach(() => {
      vi.mocked(getAvailableModels).mockResolvedValue([gptImage]);
      vi.mocked(getSettingsValue).mockImplementation(name => name === 'enforceCredits' || undefined);
      vi.mocked(silentLogger.warn).mockClear();
      editSpy.mockResolvedValue({ type: 'success', dataUrl: 'https://example.invalid/edited.png' });
    });

    afterEach(() => {
      vi.mocked(getSettingsValue).mockImplementation(() => undefined);
    });

    it('has landed the usage event by the time process() returns', async () => {
      let landed = false;
      // Settles on a later macrotask, so an unawaited write is still pending when process() resolves.
      const record = vi.fn(
        () =>
          new Promise<void>(resolve =>
            setTimeout(() => {
              landed = true;
              resolve();
            }, 0)
          )
      );

      const quest = await runCharged(record);

      expect(quest.status).toBe('done');
      expect(quest.creditHolds.settle).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'quest1',
          feature: 'image_edit',
          // The rendered image plus the primary image sent as input.
          creditsCharged: settledAtHalf(
            estimateImageCredits(gptImage, IMAGES_PER_EDIT_REQUEST, { model: gptImage.id, inputImageCount: 1 }).usdCost
          ),
        })
      );
      expect(landed).toBe(true);
    });

    it('records the confirmed charge, not the draw, when settle confirms less (the sweep already refunded)', async () => {
      const record = vi.fn(async () => undefined);

      const quest = await runCharged(record, 0);

      expect(quest.status).toBe('done');
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 0 }));
      expect(quest.creditHolds.release).not.toHaveBeenCalled();
    });

    describe('final debit rounding', () => {
      const withValidatedCost = (cost: { requiredCredits: number; usdCost: number }) =>
        vi
          .spyOn(
            ImageEditService.prototype as unknown as { estimateCredits: () => Promise<unknown> },
            'estimateCredits'
          )
          .mockResolvedValue(cost);

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each([
        [0.25, 41],
        [0.75, 40],
      ])('debits N or N+1 for a cost of N + 0.5 credits (draw %s -> %s)', async (draw, expected) => {
        withValidatedCost({ requiredCredits: 41, usdCost: 40.5 / CREDITS_PER_USD_COST });
        settlementDraw.mockReturnValue(draw);
        const record = vi.fn(async () => undefined);

        const quest = await runCharged(record);

        expect(quest.creditsUsed).toBe(expected);
        expect(quest.creditHolds.settle).toHaveBeenCalledWith(
          expect.anything(),
          expected,
          expect.objectContaining({ type: 'image_edit_usage', sessionId: 'session1', questId: 'quest1' }),
          expect.anything()
        );
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: expected }));
      });

      it('settles 0 for a tiny cost (the whole hold is refunded), and the usage event still records the edit', async () => {
        withValidatedCost({ requiredCredits: 1, usdCost: 0.00001 });
        settlementDraw.mockReturnValue(0.5);
        const record = vi.fn(async () => undefined);

        const quest = await runCharged(record);

        expect(quest.status).toBe('done');
        expect(quest.creditsUsed).toBe(0);
        expect(quest.creditHolds.settle).toHaveBeenCalledWith(
          expect.anything(),
          0,
          expect.objectContaining({ type: 'image_edit_usage' }),
          expect.anything()
        );
        expect(quest.creditHolds.release).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledWith(
          expect.objectContaining({ feature: 'image_edit', creditsCharged: 0, costUsd: 0.00001 })
        );
      });
    });

    it('still completes the edit when the usage-event write fails', async () => {
      const record = vi.fn(async () => {
        throw new Error('usage store down');
      });

      const quest = await runCharged(record);

      expect(record).toHaveBeenCalledTimes(1);
      expect(quest.type).not.toBe('error');
      expect(quest.status).toBe('done');
      expect(silentLogger.warn).toHaveBeenCalledWith('Failed to record usage event', expect.any(Error));
    });

    it('completes a charged run when db.usageEvents is absent', async () => {
      const quest = await run(ImageModels.GPT_IMAGE_1_5, {}, { creditTransactions: { create: vi.fn() } });

      expect(quest.status).toBe('done');
      expect(quest.type).not.toBe('error');
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
      assertModelAdmission: async () => {},
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => quest), update: vi.fn(async () => quest) },
        users: { findById: vi.fn(async () => richUser) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds },
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

  it('scopes the anchor lookup to the caller', async () => {
    // An unscoped lookup ignores the principal entirely; naming an id would read any user's file.
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

  it('resolves lake access once per run, anchors or not - the mask lookup needs it too', async () => {
    const withoutAnchors = await run({});
    expect(withoutAnchors.resolveLakeAccess).toHaveBeenCalledTimes(1);

    const withAnchors = await run({ referenceImageFabFileIds: ['a'] });
    expect(withAnchors.resolveLakeAccess).toHaveBeenCalledTimes(1);
  });
});

describe('ImageEditService.process mask access (#3069)', () => {
  const editSpy = vi.fn();
  const maskFile = {
    id: 'mask1',
    fileName: 'image_mask_1.png',
    mimeType: 'image/png',
    filePath: 'masks/mask1.png',
    moderationStatus: 'clean',
  };

  /**
   * `reachable` decides what the access predicate would return, so a test can model "the caller
   * owns it", "only the lake arms reach it", and "it belongs to someone else" without standing up
   * a real Mongo predicate.
   */
  const run = async (
    opts: {
      reachable?: (ids: string[], lakeAccess: unknown) => unknown[];
      model?: string;
      lakeAccess?: Record<string, unknown>;
      withResolver?: boolean;
      failLakeAccess?: boolean;
      fabFileIds?: string[];
      deleteFabFile?: (userId: string, id: string) => unknown;
    } = {}
  ) => {
    const reachable = opts.reachable ?? ((ids: string[]) => ids.map(id => (id === 'mask1' ? maskFile : null)));
    const findAccessibleInIds = vi.fn(async (ids: string[], _access: unknown, lakeAccess: unknown) =>
      reachable(ids || [], lakeAccess).filter(Boolean)
    );
    const deleteFabFile = vi.fn(opts.deleteFabFile);
    const getSignedUrl = vi.fn(async (path: string) => `https://example.invalid/${path}`);
    const resolveLakeAccess = vi.fn(async () => {
      if (opts.failLakeAccess) throw new Error('lake-resolution-outage');
      return (opts.lakeAccess ?? {}) as never;
    });
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
      assertModelAdmission: async () => {},
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => quest), update: vi.fn(async () => quest) },
        users: { findById: vi.fn(async () => richUser) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds },
      },
      startImageEditProcess: vi.fn(),
      deleteFabFile,
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: {} as never,
      fabFileStorage: { getSignedUrl } as never,
      ...(opts.withResolver === false ? {} : { resolveLakeAccess }),
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
        fabFileIds: opts.fabFileIds ?? ['mask1'],
      } as never,
      logger: silentLogger,
    });
    return { quest, findAccessibleInIds, deleteFabFile, getSignedUrl, resolveLakeAccess };
  };

  beforeEach(() => {
    editSpy.mockReset();
    editSpy.mockRejectedValue(new Error('stop-after-dispatch'));
    vi.mocked(aiImageService).mockClear();
    vi.mocked(aiImageService).mockReturnValue({ edit: editSpy } as never);
    vi.mocked(getAvailableModels).mockResolvedValue([]);
  });

  it('scopes the mask lookup to the caller and threads lake access through it', async () => {
    const { findAccessibleInIds } = await run({ lakeAccess: { dataLakeTags: ['datalake:acme'] } });

    expect(findAccessibleInIds).toHaveBeenCalledWith(
      ['mask1'],
      { userId: 'user1', userGroups: undefined },
      { dataLakeTags: ['datalake:acme'] }
    );
  });

  it('still presigns and sends a mask the caller can reach', async () => {
    const { getSignedUrl } = await run();

    expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
    expect(editSpy.mock.calls[0][2].mask).toBeTruthy();
  });

  it('still resolves a mask reachable only through the data lake', async () => {
    // The lake arms are the whole reason lakeAccess is threaded: without them a lake-only mask
    // the workbench admitted would silently stop working the moment the lookup became scoped.
    const lakeOnly = (ids: string[], lakeAccess: unknown) =>
      (lakeAccess as { dataLakeTags?: string[] })?.dataLakeTags?.length ? ids.map(() => maskFile) : [];

    const { getSignedUrl } = await run({ reachable: lakeOnly, lakeAccess: { dataLakeTags: ['datalake:acme'] } });

    expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
  });

  it('never presigns a mask that belongs to another user, and fails rather than editing without it', async () => {
    const { getSignedUrl, quest } = await run({ reachable: () => [] });

    expect(getSignedUrl).not.toHaveBeenCalled();
    // Nothing reached the provider at all - the alpha channel is the payload of this leak.
    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.type).toBe('error');
    expect(quest.reply).toContain('mask1');
    expect(quest.reply).toContain('not accessible');
  });

  it('names every unresolved id, so the caller knows which workbench file to remove', async () => {
    const { quest } = await run({ fabFileIds: ['ghost-a', 'ghost-b'], reachable: () => [] });

    expect(quest.reply).toContain('ghost-a');
    expect(quest.reply).toContain('ghost-b');
  });

  it("fails a fill edit rather than inpainting with someone else's mask", async () => {
    const { quest } = await run({ reachable: () => [], model: ImageModels.FLUX_PRO_FILL });

    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.type).toBe('error');
    // Fails at the access gate now, ahead of the fill path's own missing-mask check.
    expect(quest.reply).toContain('not accessible');
  });

  it("keeps deleting the caller's own mask, and stops handing the cleanup ids it cannot reach", async () => {
    const reachableRun = await run();
    expect(reachableRun.deleteFabFile).toHaveBeenCalledWith('user1', 'mask1');

    const foreignRun = await run({ reachable: () => [] });
    expect(foreignRun.deleteFabFile).not.toHaveBeenCalled();
  });

  it('finishes deleting the mask before process() resolves', async () => {
    // The queue Lambda freezes once process() resolves, so a cleanup that is merely started, not
    // awaited, never completes and the mask outlives a finished edit.
    let deleted = false;
    await run({
      deleteFabFile: async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        deleted = true;
      },
    });

    expect(deleted).toBe(true);
  });

  it('logs a failed mask delete instead of letting it escape the finished edit', async () => {
    const { quest } = await run({
      deleteFabFile: async () => {
        throw new Error('storage-outage');
      },
    });

    // The provider stub's rejection is still the quest's outcome; the cleanup failure does not replace it.
    expect(quest.reply).toBe('stop-after-dispatch');
    expect(silentLogger.warn).toHaveBeenCalledWith(
      '[ImageEdit] Failed to delete temporary mask file',
      expect.objectContaining({ fileId: 'mask1', error: 'storage-outage' })
    );
  });

  it('degrades to owner/share/global-read when no lake resolver is wired, rather than failing', async () => {
    const { findAccessibleInIds, getSignedUrl } = await run({ withResolver: false });

    expect(findAccessibleInIds).toHaveBeenCalledWith(['mask1'], { userId: 'user1', userGroups: undefined }, undefined);
    expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
  });

  it('fails the quest instead of substituting a mask when lake access cannot be determined', async () => {
    const { quest, deleteFabFile } = await run({
      failLakeAccess: true,
      reachable: () => [], // nothing resolves by ownership, so an id genuinely goes missing
    });

    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.type).toBe('error');
    expect(quest.reply).toContain('data-lake lookup failed');
    expect(quest.status).toBe('done');
    // Nothing resolved, so there is no mask to clean up - and crucially no provider dispatch.
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it('never sends the second mask to the provider when the first one cannot be resolved', async () => {
    // The substitution this guards, with both ids actually present rather than described: the
    // caller's list is [lakeOnlyMask, ownBrushedMask] and only the second resolves. The mask slot
    // is positional - `fabFiles.find(first image)` - so dropping the first silently promotes the
    // second, and the edit renders and bills on an input the caller never chose. Asserted on the
    // provider payload, because "which bytes reached the provider" is the whole claim.
    const ownMask = { ...maskFile, id: 'own-mask', filePath: 'masks/own.png' };
    const { quest, getSignedUrl } = await run({
      fabFileIds: ['lake-only-mask', 'own-mask'],
      reachable: ids => ids.map(id => (id === 'own-mask' ? ownMask : null)),
    });

    expect(editSpy).not.toHaveBeenCalled();
    // The substitute was never even presigned, let alone sent as an alpha channel.
    expect(getSignedUrl).not.toHaveBeenCalledWith('masks/own.png');
    expect(quest.type).toBe('error');
    expect(quest.reply).toContain('lake-only-mask');
  });

  it('keeps the painted mask when a workbench file beside it is inaccessible, so a retry can reuse it', async () => {
    // [unreachable workbench file, freshly painted mask]: the guard fails the edit before dispatch
    // and tells the caller to remove the bad file and retry - which only works if the mask id they
    // retry with still exists. deleteFabFile mutates the store so the retry sees the real outcome.
    const ownMask = { ...maskFile, id: 'own-mask', filePath: 'masks/own.png' };
    const live = new Set(['own-mask']);
    const reachable = (ids: string[]) => ids.map(id => (live.has(id) ? ownMask : null));
    const deleteFromStore = (_userId: string, id: string) => live.delete(id);

    const failed = await run({ fabFileIds: ['ghost-file', 'own-mask'], reachable, deleteFabFile: deleteFromStore });

    expect(editSpy).not.toHaveBeenCalled();
    expect(failed.quest.type).toBe('error');
    expect(failed.quest.reply).toContain('ghost-file');
    expect(failed.deleteFabFile).not.toHaveBeenCalled();

    const retry = await run({ fabFileIds: ['own-mask'], reachable, deleteFabFile: deleteFromStore });

    expect(retry.getSignedUrl).toHaveBeenCalledWith('masks/own.png');
    expect(editSpy).toHaveBeenCalledTimes(1);
    // The run that did reach dispatch still cleans up its temporary mask.
    expect(retry.deleteFabFile).toHaveBeenCalledWith('user1', 'own-mask');
    expect(live.has('own-mask')).toBe(false);
  });

  it('keeps the painted mask when a lake outage leaves a lake-only file beside it unresolved', async () => {
    // Same guard, outage branch: the first file needs lake membership the failed resolver could
    // not supply, while the mask resolves by ownership.
    const ownMask = { ...maskFile, id: 'own-mask', filePath: 'masks/own.png' };
    const { quest, deleteFabFile } = await run({
      failLakeAccess: true,
      fabFileIds: ['lake-only-file', 'own-mask'],
      reachable: ids => ids.map(id => (id === 'own-mask' ? ownMask : null)),
    });

    expect(editSpy).not.toHaveBeenCalled();
    expect(quest.reply).toContain('data-lake lookup failed');
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it("sends the caller's own mask when every id in a two-id list resolves", async () => {
    // The control for the case above: same two-id shape, both reachable, so the positional pick
    // still happens normally and the guard is not just failing everything with two ids.
    const ownMask = { ...maskFile, id: 'own-mask', filePath: 'masks/own.png' };
    const { getSignedUrl, quest } = await run({
      fabFileIds: ['mask1', 'own-mask'],
      reachable: ids => ids.map(id => (id === 'own-mask' ? ownMask : maskFile)),
    });

    expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
    expect(quest.reply).toBe('stop-after-dispatch');
  });

  it('still runs when the lake resolver fails but every requested id resolves by ownership', async () => {
    // A lake outage must not break edits that never needed the lake arms.
    const { quest, getSignedUrl } = await run({ failLakeAccess: true });

    expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
    // 'stop-after-dispatch' is the provider stub - the run reached dispatch.
    expect(quest.reply).toBe('stop-after-dispatch');
  });

  it('degrades rather than stranding the quest when the lake resolver itself rejects', async () => {
    // This resolution used to sit above the try/catch that owns the quest's terminal write, where
    // an unhandled rejection escaped `process` with no terminal write at all. Not a 'running' row
    // for the check-timeout reaper either: `status = 'running'` is only in memory until
    // startQuestHeartbeat persists it, and that runs inside the try - so the quest kept whatever
    // status it was enqueued with and nothing would ever have reclaimed it. The run must reach
    // dispatch on the ownership arms alone.
    const { findAccessibleInIds, quest } = await run({ failLakeAccess: true });

    // Empty buckets (never widened) but flagged, so the guard above can tell an outage from a deny.
    expect(findAccessibleInIds).toHaveBeenCalledWith(
      ['mask1'],
      { userId: 'user1', userGroups: undefined },
      { resolutionFailed: true }
    );
    // 'stop-after-dispatch' is the provider stub - proof the outage did not short-circuit the run.
    expect(quest.reply).toBe('stop-after-dispatch');
    expect(quest.status).toBe('done');
  });

  describe('mask still being moderation-scanned', () => {
    const withStatus = (moderationStatus: string) => ({ ...maskFile, moderationStatus });
    // First call is the access-scoped load in process(); later calls are the gate's re-reads.
    const sequence = (statuses: string[]) => {
      let call = 0;
      return () => [withStatus(statuses[Math.min(call++, statuses.length - 1)])];
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    const runWithTimers = async (opts: Parameters<typeof run>[0]) => {
      vi.useFakeTimers();
      const pending = run(opts);
      await vi.advanceTimersByTimeAsync(20_000);
      return pending;
    };

    it('waits for a pending mask to turn clean, then dispatches the edit', async () => {
      const { getSignedUrl, findAccessibleInIds } = await runWithTimers({
        reachable: sequence(['pending', 'pending', 'clean']),
      });

      expect(findAccessibleInIds).toHaveBeenCalledTimes(3);
      expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
      expect(editSpy).toHaveBeenCalled();
    });

    it('re-reads through the same access-scoped lookup, with the same lake access', async () => {
      const lakeAccess = { dataLakeTags: ['datalake:acme'] };
      const { findAccessibleInIds } = await runWithTimers({
        reachable: sequence(['pending', 'clean']),
        lakeAccess,
      });

      expect(findAccessibleInIds).toHaveBeenNthCalledWith(
        1,
        ['mask1'],
        { userId: 'user1', userGroups: undefined },
        lakeAccess
      );
      expect(findAccessibleInIds).toHaveBeenNthCalledWith(
        2,
        ['mask1'],
        { userId: 'user1', userGroups: undefined },
        lakeAccess
      );
    });

    it('fails closed with a retry message when the scan outlasts the wait', async () => {
      const { quest, getSignedUrl, findAccessibleInIds } = await runWithTimers({ reachable: sequence(['pending']) });

      // Initial load plus one re-read per 750ms across the 12s budget.
      expect(findAccessibleInIds.mock.calls.length).toBeGreaterThanOrEqual(16);
      expect(getSignedUrl).not.toHaveBeenCalled();
      expect(editSpy).not.toHaveBeenCalled();
      expect(quest.type).toBe('error');
      expect(quest.reply).toContain('still being scanned');
    });

    it('fails fast, without polling, when the mask is already blocked', async () => {
      const { quest, findAccessibleInIds } = await run({ reachable: sequence(['blocked']) });

      expect(findAccessibleInIds).toHaveBeenCalledTimes(1);
      expect(editSpy).not.toHaveBeenCalled();
      expect(quest.reply).toContain('blocked by moderation');
    });

    it("waits through 'scanning', the state a mask is in when the S3 event owns the claim", async () => {
      const { getSignedUrl, findAccessibleInIds } = await runWithTimers({
        reachable: sequence(['scanning', 'scanning', 'clean']),
      });

      expect(findAccessibleInIds).toHaveBeenCalledTimes(3);
      expect(getSignedUrl).toHaveBeenCalledWith('masks/mask1.png');
      expect(editSpy).toHaveBeenCalled();
    });

    it("fails closed with the retry message when a 'scanning' mask outlasts the wait", async () => {
      const { quest, findAccessibleInIds } = await runWithTimers({ reachable: sequence(['scanning']) });

      expect(findAccessibleInIds.mock.calls.length).toBeGreaterThanOrEqual(16);
      expect(editSpy).not.toHaveBeenCalled();
      expect(quest.type).toBe('error');
      expect(quest.reply).toContain('still being scanned');
    });

    it('stops polling and fails closed when the mask disappears mid-wait', async () => {
      let call = 0;
      const { quest, findAccessibleInIds } = await runWithTimers({
        reachable: () => (call++ === 0 ? [withStatus('pending')] : []),
      });

      expect(findAccessibleInIds).toHaveBeenCalledTimes(2);
      expect(editSpy).not.toHaveBeenCalled();
      expect(quest.type).toBe('error');
      expect(quest.reply).toContain('not available');
      expect(quest.reply).not.toContain('still being scanned');
    });

    it('reports blocked, not retry, when the scan resolves to blocked mid-wait', async () => {
      const { quest } = await runWithTimers({ reachable: sequence(['pending', 'blocked']) });

      expect(editSpy).not.toHaveBeenCalled();
      expect(quest.reply).toContain('blocked by moderation');
    });
  });
});

describe('ImageEditService.invoke (retry quest bound to its session)', () => {
  const makeInvokeService = (questSessionId: string) => {
    const update = vi.fn(async () => undefined);
    const startImageEditProcess = vi.fn(async () => undefined);
    const service = new ImageEditService({
      assertModelAdmission: async () => {},
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: {
          findById: vi.fn(async () => ({
            id: 'quest1',
            sessionId: questSessionId,
            // The prior run failed; the retry must not inherit its error state.
            status: 'done',
            type: 'error',
            errorCode: 'insufficient_credits',
          })),
          update,
        },
      },
      startImageEditProcess,
    } as never);
    const invoke = () =>
      service.invoke({
        body: {
          sessionId: 'session1',
          questId: 'quest1',
          prompt: 'make it blue',
          model: 'gpt-image-1',
          image: 'https://example.invalid/source.png',
          fabFileIds: ['mask1'],
        } as never,
        userId: 'user1',
      });
    return { invoke, update, startImageEditProcess };
  };

  it('refuses a questId from another session before touching the quest', async () => {
    const { invoke, update, startImageEditProcess } = makeInvokeService('other-session');
    await expect(invoke()).rejects.toThrow('Quest not found');
    expect(update).not.toHaveBeenCalled();
    expect(startImageEditProcess).not.toHaveBeenCalled();
  });

  it('retries a quest from the same session', async () => {
    const { invoke, update } = makeInvokeService('session1');
    await invoke();
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'quest1', type: 'message' }), {
      unset: ['status', 'errorCode'],
    });
  });

  it('settles the quest as a done error when the process fails to start', async () => {
    const { invoke, update, startImageEditProcess } = makeInvokeService('session1');
    startImageEditProcess.mockRejectedValueOnce(new Error('queue unavailable'));
    await invoke();
    expect(update).toHaveBeenLastCalledWith({
      id: 'quest1',
      type: 'error',
      status: 'done',
      reply: 'queue unavailable',
    });
  });
});

describe('ImageEditService quest partial writes', () => {
  const editSpy = vi.fn();
  const promptMeta = { marker: 'meta' };

  const makeService = (
    questSessionId = 'session1',
    saveGeneratedAsset: SaveGeneratedAssetFn = vi.fn(async () => ({ saved: true }) as never),
    dbExtras: Record<string, unknown> = {}
  ) => {
    const quest: Record<string, unknown> = {
      id: 'quest1',
      sessionId: questSessionId,
      prompt: 'make it blue',
      type: 'message',
      replies: ['stale'],
      images: ['stale.png'],
      promptMeta,
    };
    const update = vi.fn(async () => quest);
    const startImageEditProcess = vi.fn(async () => undefined);
    const creditHolds = makeCreditHolds();
    const service = new ImageEditService({
      assertModelAdmission: async () => {},
      creditHolds,
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => quest), update },
        users: { findById: vi.fn(async () => richUser) },
        organizations: { findById: vi.fn(async () => null) },
        fabFiles: { findAccessibleInIds: vi.fn(async () => []) },
        ...dbExtras,
      },
      startImageEditProcess,
      saveGeneratedAsset,
      deleteFabFile: vi.fn(),
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: { upload: vi.fn(async () => 'stored/out.png') } as never,
      fabFileStorage: { getSignedUrl: vi.fn(async () => 'https://example.invalid/x.png') } as never,
    } as never);
    (service as unknown as { tokenizer: unknown }).tokenizer = {
      encodeTokens: vi.fn(async () => [1, 2, 3]),
      decodeTokens: vi.fn(async () => 'make it blue'),
    };
    return { service, quest, update, startImageEditProcess, creditHolds };
  };

  const process = (service: ImageEditService, generationId?: string) =>
    service.process({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        userId: 'user1',
        generationId,
        prompt: 'make it blue',
        model: ImageModels.GPT_IMAGE_1_5,
        image: 'https://example.invalid/source.png',
        fabFileIds: [],
      } as never,
      logger: silentLogger,
    });

  const invoke = (service: ImageEditService) =>
    service.invoke({
      body: {
        sessionId: 'session1',
        questId: 'quest1',
        prompt: 'make it blue',
        model: 'gpt-image-1',
        image: 'https://example.invalid/source.png',
        fabFileIds: ['mask1'],
      } as never,
      userId: 'user1',
    });

  beforeEach(() => {
    editSpy.mockReset();
    vi.mocked(aiImageService).mockReturnValue({ edit: editSpy } as never);
    vi.mocked(getAvailableModels).mockResolvedValue([gptImage]);
  });

  afterEach(() => {
    vi.mocked(getSettingsValue).mockImplementation(() => undefined);
  });

  const retryResetWrite = {
    id: 'quest1',
    images: [],
    replies: [],
    type: 'message',
    promptMeta: {
      model: { name: 'gpt-image-1', parameters: {} },
      session: { id: 'session1', userId: 'user1' },
    },
  };

  it('invoke retry writes exactly images, replies, type and promptMeta', async () => {
    const { service, update } = makeService();
    await invoke(service);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toStrictEqual(retryResetWrite);
    expect(update.mock.calls[0][1]).toStrictEqual({ unset: ['status', 'errorCode'] });
  });

  it('invoke catch writes exactly type, status and reply', async () => {
    const { service, update, startImageEditProcess } = makeService();
    startImageEditProcess.mockRejectedValue(new Error('queue down'));
    await invoke(service);

    // The retry reset, then the error write; a third (e.g. a whole-quest write) is a regression.
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0]).toStrictEqual(retryResetWrite);
    expect(update.mock.calls[0][1]).toStrictEqual({ unset: ['status', 'errorCode'] });
    const errorCall = update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.type === 'error');
    expect(errorCall).toStrictEqual({ id: 'quest1', type: 'error', status: 'done', reply: 'queue down' });
  });

  it('process success writes exactly reply, replies, images, status and creditsUsed (no promptMeta)', async () => {
    editSpy.mockResolvedValue({ type: 'success', dataUrl: 'https://example.invalid/out.png' });
    vi.mocked(getSettingsValue).mockImplementation(key => (key === 'ImageModerationEnabled' ? false : undefined));
    const { service, update } = makeService();
    await process(service);

    expect(update).toHaveBeenCalledTimes(1);
    const doneCall = update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.status === 'done');
    expect(doneCall).toStrictEqual({
      id: 'quest1',
      reply: '',
      replies: [],
      images: ['stored/out.png'],
      status: 'done',
      creditsUsed: undefined,
    });
  });

  describe('settled credits persistence', () => {
    const withValidatedCost = (cost: { requiredCredits: number; usdCost: number }) =>
      vi
        .spyOn(ImageEditService.prototype as unknown as { estimateCredits: () => Promise<unknown> }, 'estimateCredits')
        .mockResolvedValue(cost);

    const arrangeBilled = () => {
      editSpy.mockResolvedValue({ type: 'success', dataUrl: 'https://example.invalid/out.png' });
      return makeService('session1', undefined, { creditTransactions: { create: vi.fn() } });
    };

    const doneWrite = (update: ReturnType<typeof vi.fn>) =>
      update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.status === 'done');

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('persists the settled draw rather than the round-up pre-flight figure', async () => {
      // The gate reserved 7; settlement draws on 6.5 credits and must persist 6.
      withValidatedCost({ requiredCredits: 7, usdCost: 6.5 / CREDITS_PER_USD_COST });
      vi.mocked(getSettingsValue).mockImplementation(key => (key === 'enforceCredits' ? true : undefined));
      settlementDraw.mockReturnValue(0.75);
      const { service, update } = arrangeBilled();

      await process(service);

      expect(doneWrite(update)?.creditsUsed).toBe(6);
    });

    it('draws and debits nothing when credit enforcement is off', async () => {
      const { service, update, quest, creditHolds } = arrangeBilled();
      // A quest that already carries a pre-flight figure: without the enforcement term the
      // settlement would draw and debit it even though billing is off.
      quest.creditsUsed = 7;
      settlementDraw.mockClear();

      await process(service);

      expect(settlementDraw).not.toHaveBeenCalled();
      expect(creditHolds.hold).not.toHaveBeenCalled();
      expect(creditHolds.settle).not.toHaveBeenCalled();
      expect(doneWrite(update)?.creditsUsed).toBe(7);
    });
  });

  describe('saving the edited image to the user files', () => {
    const arrange = (saveGeneratedAsset: SaveGeneratedAssetFn, dbExtras: Record<string, unknown> = {}) => {
      editSpy.mockResolvedValue({ type: 'success', dataUrl: 'https://example.invalid/out.png' });
      vi.mocked(getSettingsValue).mockImplementation(key => (key === 'ImageModerationEnabled' ? false : undefined));
      return makeService('session1', saveGeneratedAsset, dbExtras);
    };

    const arrangeBilled = (saveGeneratedAsset: SaveGeneratedAssetFn) => {
      const arranged = arrange(saveGeneratedAsset, { creditTransactions: { create: vi.fn() } });
      vi.mocked(getSettingsValue).mockImplementation(key =>
        key === 'enforceCredits' ? true : key === 'ImageModerationEnabled' ? false : undefined
      );
      return arranged;
    };

    it('saves the stored image once, keyed by the generationId', async () => {
      const save = vi.fn<SaveGeneratedAssetFn>(async () => ({ saved: true }) as never);
      const { service } = arrange(save);
      await process(service, 'gen-1');

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0]).toMatchObject({
        userId: 'user1',
        sessionId: 'session1',
        questId: 'quest1',
        contentType: 'image/png',
        generation: {
          generator: 'image',
          provider: 'openai',
          modelId: ImageModels.GPT_IMAGE_1_5,
          prompt: 'make it blue',
          jobId: 'gen-1',
        },
      });
    });

    it('records reference lineage and the request, never the mask', async () => {
      const save = vi.fn<SaveGeneratedAssetFn>(async () => ({ saved: true }) as never);
      const image = (id: string, fileName: string) => ({
        id,
        fileName,
        mimeType: 'image/png',
        filePath: `fab/${id}.png`,
        moderationStatus: 'clean',
      });
      const files: Record<string, unknown> = { mask1: image('mask1', 'image_mask_1.png'), r1: image('r1', 'ref.png') };
      const { service } = arrange(save, {
        fabFiles: { findAccessibleInIds: vi.fn(async (ids: string[]) => ids.map(id => files[id]).filter(Boolean)) },
      });
      await service.process({
        body: {
          sessionId: 'session1',
          questId: 'quest1',
          userId: 'user1',
          generationId: 'gen-1',
          prompt: 'make it blue',
          model: ImageModels.GPT_IMAGE_1_5,
          image: 'https://example.invalid/source.png',
          fabFileIds: ['mask1'],
          referenceImageFabFileIds: ['r1'],
        } as never,
        logger: silentLogger,
      });

      const saved = save.mock.calls[0][0];
      expect(saved.derivedFrom).toEqual([{ fileId: 'r1', role: 'reference' }]);
      expect(saved.generation.request).toMatchObject({ model: ImageModels.GPT_IMAGE_1_5, prompt: 'make it blue' });
      expect(JSON.stringify(saved.generation.request)).not.toMatch(/source\.png|mask1/);
    });

    it('saves nothing when billing fails', async () => {
      const save = vi.fn<SaveGeneratedAssetFn>(async () => ({ saved: true }) as never);
      const { service, update, creditHolds } = arrangeBilled(save);
      creditHolds.settle.mockRejectedValueOnce(new Error('billing down'));
      await process(service, 'gen-1');

      expect(save).not.toHaveBeenCalled();
      expect(creditHolds.release).toHaveBeenCalledTimes(1);
      expect(
        update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.type === 'error')
      ).toMatchObject({ reply: 'billing down' });
    });

    it('saves nothing when the done write fails', async () => {
      const save = vi.fn<SaveGeneratedAssetFn>(async () => ({ saved: true }) as never);
      const { service, update } = arrange(save);
      update.mockImplementation(async (arg: Record<string, unknown>) => {
        if ('images' in arg) throw new Error('write failed');
        return arg;
      });
      await process(service, 'gen-1');

      expect(save).not.toHaveBeenCalled();
      expect(
        update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.type === 'error')
      ).toMatchObject({ reply: 'write failed' });
    });

    it('still finishes the quest when the save rejects', async () => {
      const { service, update } = arrange(vi.fn(async () => Promise.reject(new Error('disk full'))));
      await process(service, 'gen-1');

      const doneCall = update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.status === 'done');
      expect(doneCall).toMatchObject({ status: 'done', images: ['stored/out.png'] });
    });

    it('still finishes the quest when the save reports storage_limit', async () => {
      const { service, update } = arrange(vi.fn(async () => ({ saved: false, reason: 'storage_limit' }) as never));
      await process(service, 'gen-1');

      const doneCall = update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.status === 'done');
      expect(doneCall).toMatchObject({ status: 'done', images: ['stored/out.png'] });
    });
  });

  it('invoke stamps a non-empty generationId on the queued body', async () => {
    const { service, startImageEditProcess } = makeService();
    await invoke(service);

    const [queued] = startImageEditProcess.mock.calls[0] as unknown as [{ generationId?: unknown }];
    expect(typeof queued.generationId).toBe('string');
    expect(queued.generationId).not.toBe('');
  });

  it('process error writes exactly the seven error fields', async () => {
    editSpy.mockRejectedValue(new Error('provider down'));
    const { service, update } = makeService();
    await process(service);

    expect(update).toHaveBeenCalledTimes(1);
    const errorCall = update.mock.calls.map(c => c[0] as Record<string, unknown>).find(arg => arg.type === 'error');
    expect(errorCall).toStrictEqual({
      id: 'quest1',
      prompt: 'make it blue',
      reply: 'provider down',
      type: 'error',
      status: 'done',
      errorCode: undefined,
      // A literal, not the shared `promptMeta` the quest holds: a test comparing an object with
      // itself would pass even if process() started mutating it before the write.
      promptMeta: { marker: 'meta' },
    });
  });
});

describe('ImageEditService.process (settled quest and early failure)', () => {
  const makeService = (questStatus: string | undefined, usersFindById: ReturnType<typeof vi.fn>) => {
    const quest = { id: 'quest1', sessionId: 'session1', status: questStatus } as Record<string, unknown>;
    const update = vi.fn(async () => undefined);
    const service = new ImageEditService({
      assertModelAdmission: async () => {},
      db: {
        quests: { findById: vi.fn(async () => quest), update },
        users: { findById: usersFindById },
        organizations: { findById: vi.fn(async () => null) },
      },
      startImageEditProcess: vi.fn(),
      deleteFabFile: vi.fn(),
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: {} as never,
      fabFileStorage: {} as never,
    } as never);
    const run = () =>
      service.process({
        body: {
          sessionId: 'session1',
          questId: 'quest1',
          userId: 'user1',
          prompt: 'make it blue',
          model: ImageModels.GPT_IMAGE_1_5,
          image: 'https://example.invalid/source.png',
          fabFileIds: [],
        } as never,
        logger: silentLogger,
      });
    return { run, quest, update };
  };

  it('settles the quest with an error when the user lookup rejects', async () => {
    const { run, quest, update } = makeService(undefined, vi.fn().mockRejectedValue(new Error('db down')));

    await run();

    expect(quest).toMatchObject({ type: 'error', status: 'done' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'quest1', type: 'error', status: 'done' }));
  });

  it.each(['done', 'stopped'])('does nothing when the quest is already %s', async status => {
    const users = vi.fn();
    const { run, update } = makeService(status, users);

    await run();

    expect(users).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
