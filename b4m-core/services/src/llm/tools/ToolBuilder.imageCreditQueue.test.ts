import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { validateUserCredits } from './base/utils';

// Stub the image cost calculator so the image-reservation tests exercise the reservation
// wiring (one push per call, guard conditions) without an image-pricing fixture.
vi.mock('./base/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('./base/utils')>();
  return { ...actual, validateUserCredits: vi.fn() };
});
const mockValidateUserCredits = vi.mocked(validateUserCredits);

const makeBuilder = ({
  credits = 1_000_000,
  hasCreditStore = true,
}: { credits?: number; hasCreditStore?: boolean } = {}) => {
  const toolCreditsMap = new Map<string, number[]>();
  const toolCreditModels = new Set<string>();
  const record = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
  const deps = {
    user: { id: 'u1', currentCredits: credits },
    logger,
    db: {
      creditTransactions: hasCreditStore ? {} : undefined,
      usageEvents: { record },
    },
    toolCreditsMap,
    toolCreditModels,
  } as unknown as ToolBuilderConfig;
  return { builder: new ToolBuilder(deps), toolCreditsMap, toolCreditModels, record };
};

// image_generation/edit_image feed the per-name credit queue, so these guard that two image
// calls in a turn reserve independently (sum, not double) and that the guard conditions still
// short-circuit.
describe('ToolBuilder image credit reservation', () => {
  const MODELS = [{ id: 'gpt-image-1', backend: 'openai' } as ModelInfo];
  const quest = () => ({ id: 'q1', sessionId: 's1', creditsUsed: 0, images: [] as string[] }) as never;
  const saveQuest = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    mockValidateUserCredits.mockReset();
    saveQuest.mockClear();
  });

  it('reserves one queue entry per call so two image calls sum instead of doubling', async () => {
    mockValidateUserCredits
      .mockResolvedValueOnce({ requiredCredits: 400, usdCost: 0.08 })
      .mockResolvedValueOnce({ requiredCredits: 900, usdCost: 0.18 });
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();
    const data = { model: 'gpt-image-1', n: 1 };
    await builder.reserveImageCredits('image_generation', data, true, null, q, saveQuest, MODELS);
    await builder.reserveImageCredits('image_generation', data, true, null, q, saveQuest, MODELS);
    expect(toolCreditsMap.get('image_generation')).toEqual([400, 900]);
    expect(q.creditsUsed).toBe(1300);
  });

  it('reserves nothing when enforceCredits is off', async () => {
    const { builder, toolCreditsMap } = makeBuilder();
    await builder.reserveImageCredits(
      'image_generation',
      { model: 'gpt-image-1' },
      false,
      null,
      quest(),
      saveQuest,
      MODELS
    );
    expect(toolCreditsMap.has('image_generation')).toBe(false);
    expect(mockValidateUserCredits).not.toHaveBeenCalled();
  });

  it('reserves nothing when the model is unknown or absent', async () => {
    const { builder, toolCreditsMap } = makeBuilder();
    await builder.reserveImageCredits(
      'image_generation',
      { model: 'no-such-model' },
      true,
      null,
      quest(),
      saveQuest,
      MODELS
    );
    await builder.reserveImageCredits('image_generation', {}, true, null, quest(), saveQuest, MODELS);
    expect(toolCreditsMap.has('image_generation')).toBe(false);
    expect(mockValidateUserCredits).not.toHaveBeenCalled();
  });

  it('reserves nothing when the credit store is unavailable', async () => {
    const { builder, toolCreditsMap } = makeBuilder({ hasCreditStore: false });
    await builder.reserveImageCredits(
      'image_generation',
      { model: 'gpt-image-1' },
      true,
      null,
      quest(),
      saveQuest,
      MODELS
    );
    expect(toolCreditsMap.has('image_generation')).toBe(false);
  });
});
