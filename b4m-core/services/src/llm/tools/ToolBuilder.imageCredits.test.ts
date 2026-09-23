import { describe, it, expect, vi } from 'vitest';
import { ImageModels, ModelBackend, usdToCredits, type ModelInfo } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { resolveAggregateToolModel } from '../settleToolCredits';

// Drives the REAL reserveImageCredits -> validateUserCredits -> computeImageUsdCostPerImage
// chain that onToolStart delegates to. The edit_image tool's own tests mock context.onStart,
// so they pin the billed model id but never price it - that gap let an id with no cost-table
// entry (FLUX_PRO_FILL) reach production as a thrown "Model not supported".
// Mirrors ToolBuilder.audioCredits.test.ts.

const makeBuilder = ({ credits = 1_000_000 }: { credits?: number } = {}) => {
  const toolCreditsMap = new Map<string, number[]>();
  const toolCreditModels = new Set<string>();
  const record = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
  const deps = {
    user: { id: 'u1', currentCredits: credits },
    logger,
    db: { creditTransactions: {}, usageEvents: { record } },
    toolCreditsMap,
    toolCreditModels,
  } as unknown as ToolBuilderConfig;
  return { builder: new ToolBuilder(deps), toolCreditsMap, toolCreditModels, record };
};

const quest = () => ({ id: 'q1', sessionId: 's1', creditsUsed: 0, images: [] as string[] }) as never;
const saveQuest = vi.fn().mockResolvedValue(null);

const imageModel = (id: ImageModels, backend: ModelBackend): ModelInfo =>
  ({ id, type: 'image', name: id, backend }) as ModelInfo;

const AVAILABLE_MODELS = [
  imageModel(ImageModels.FLUX_PRO_FILL, ModelBackend.BFL),
  imageModel(ImageModels.FLUX_PRO_1_1, ModelBackend.BFL),
  imageModel(ImageModels.GPT_IMAGE_1_5, ModelBackend.OpenAI),
];

describe('ToolBuilder.reserveImageCredits - edit_image billing targets', () => {
  // FLUX_PRO_FILL is the only BFL model EDIT_SUPPORTED_IMAGE_MODELS allows, and the
  // edit_image fallback picks it for ANY BFL generation model with no explicit editModel.
  // Billing the model that renders is only correct if that model is actually priceable.
  it('reserves credits for a BFL edit billed as FLUX_PRO_FILL', async () => {
    const { builder, toolCreditsMap } = makeBuilder();
    const q = quest();

    await builder.reserveImageCredits(
      'edit_image',
      { model: ImageModels.FLUX_PRO_FILL, n: 1 },
      true,
      null,
      q,
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(toolCreditsMap.get('edit_image')).toEqual([usdToCredits(0.05)]);
    expect((q as unknown as { creditsUsed: number }).creditsUsed).toBe(usdToCredits(0.05));
  });

  it('records the usage event against the rendering model, not the generation model', async () => {
    const { builder, record } = makeBuilder();

    await builder.reserveImageCredits(
      'edit_image',
      { model: ImageModels.FLUX_PRO_FILL, n: 1 },
      true,
      null,
      quest(),
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ model: ImageModels.FLUX_PRO_FILL });
  });

  // Named image_generation deliberately: this estimator is shared, and n only means something
  // on the generation side. The edit_image tool now reserves IMAGES_PER_EDIT_REQUEST whatever
  // was asked for (see its own tests), because edit() returns a single image - so clamping n
  // HERE would silently stop generation billing for images it really does render.
  it('scales the reservation by n, which only generation can honor', async () => {
    const { builder, toolCreditsMap } = makeBuilder();

    await builder.reserveImageCredits(
      'image_generation',
      { model: ImageModels.FLUX_PRO_FILL, n: 3 },
      true,
      null,
      quest(),
      saveQuest,
      AVAILABLE_MODELS
    );

    // Mirrors the production order of operations (per-image USD scaled by n, THEN
    // converted): 0.05 * 3 is not exactly 0.15 in binary float, and usdToCredits rounds
    // up, so usdToCredits(0.05 * 3) is one credit above usdToCredits(0.15).
    expect(toolCreditsMap.get('image_generation')).toEqual([usdToCredits(0.05 * 3)]);
  });

  it('prices the OpenAI edit fallback too, so neither fallback branch can throw', async () => {
    const { builder, toolCreditsMap } = makeBuilder();

    await builder.reserveImageCredits(
      'edit_image',
      { model: ImageModels.GPT_IMAGE_1_5, n: 1, quality: 'high', size: '1024x1024' },
      true,
      null,
      quest(),
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(toolCreditsMap.get('edit_image')?.[0]).toBeGreaterThan(0);
  });
});

describe('ToolBuilder.reserveImageCredits - ledger model attribution', () => {
  // The quest's single aggregate tool_usage ledger row used to carry the CHAT model.
  // These lock the raw material that lets it carry the model that actually charged.
  it('records the billed image model as a charging model', async () => {
    const { builder, toolCreditModels } = makeBuilder();

    await builder.reserveImageCredits(
      'image_generation',
      { model: ImageModels.FLUX_PRO_1_1, n: 1 },
      true,
      null,
      quest(),
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(Array.from(toolCreditModels)).toEqual([ImageModels.FLUX_PRO_1_1]);
  });

  it('keeps both models when two image models charge in one turn', async () => {
    const { builder, toolCreditModels } = makeBuilder();
    const q = quest();

    await builder.reserveImageCredits(
      'image_generation',
      { model: ImageModels.FLUX_PRO_1_1, n: 1 },
      true,
      null,
      q,
      saveQuest,
      AVAILABLE_MODELS
    );
    await builder.reserveImageCredits(
      'edit_image',
      { model: ImageModels.FLUX_PRO_FILL, n: 1 },
      true,
      null,
      q,
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(Array.from(toolCreditModels).sort()).toEqual([ImageModels.FLUX_PRO_1_1, ImageModels.FLUX_PRO_FILL].sort());
  });

  it('records nothing when credit enforcement is off, since no ledger row is written', async () => {
    const { builder, toolCreditModels } = makeBuilder();

    await builder.reserveImageCredits(
      'image_generation',
      { model: ImageModels.FLUX_PRO_1_1, n: 1 },
      false,
      null,
      quest(),
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(toolCreditModels.size).toBe(0);
  });
});

// Joins the two halves the unit tests cover separately: the set ToolBuilder populates
// feeds the resolver that picks the ledger row's model. ChatCompletionProcess owns the
// literal wiring (`resolveAggregateToolModel(this.toolCreditModels)` at its subtractCredits
// call) and has no test harness of its own, so this covers the data contract between the
// two, not that call site.
describe('charging models -> aggregate ledger model', () => {
  it('names the image model when it is the only tool that charged', async () => {
    const { builder, toolCreditModels } = makeBuilder();

    await builder.reserveImageCredits(
      'image_generation',
      { model: ImageModels.FLUX_PRO_1_1, n: 1 },
      true,
      null,
      quest(),
      saveQuest,
      AVAILABLE_MODELS
    );

    expect(resolveAggregateToolModel(toolCreditModels)).toBe(ImageModels.FLUX_PRO_1_1);
  });

  it('names nothing once a second tool charges on a different model', async () => {
    const { builder, toolCreditModels } = makeBuilder();
    const q = quest();

    await builder.reserveImageCredits(
      'image_generation',
      { model: ImageModels.FLUX_PRO_1_1, n: 1 },
      true,
      null,
      q,
      saveQuest,
      AVAILABLE_MODELS
    );
    builder.settleAudioCredits(
      q,
      { kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000, paths: ['a.mp3'] },
      true
    );

    expect(toolCreditModels.size).toBe(2);
    expect(resolveAggregateToolModel(toolCreditModels)).toBeUndefined();
  });
});
