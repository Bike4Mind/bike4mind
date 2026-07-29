import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageModels, ModelBackend, type IUserDocument, type ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { estimateImageCredits } from '../imageCost';
import { ImageEditService } from './ImageEdit';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn() };
});

vi.mock('../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../apiKeyService')>();
  return { ...actual, getEffectiveLLMApiKeys: vi.fn(async () => ({ bfl: 'bfl-key' })) };
});

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
