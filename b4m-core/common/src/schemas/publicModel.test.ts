import { describe, expect, it } from 'vitest';
import { ImageModels, ModelBackend, type ModelInfo } from '../models';
import { getImageModelCapabilities } from '../utils/imageCapabilities';
import { CREDITS_PER_USD_COST } from '../pricing';
import { listModelsContract } from '../api-contract/contracts/models.contract';
import { ListModelsResponseSchema, PublicModelSchema, toPublicModel } from './publicModel';

const project = (model: ModelInfo) => toPublicModel(model, { reasonsWithinOutputBudget: false, reasoningEfforts: [] });

const textModel: ModelInfo = {
  id: 'gpt-4o' as ModelInfo['id'],
  type: 'text',
  name: 'GPT-4o',
  backend: ModelBackend.OpenAI,
  contextWindow: 128_000,
  max_tokens: 16_384,
  can_stream: true,
  supportsTools: true,
  supportsVision: true,
  supportsImageVariation: false,
  pricing: { 128_000: { input: 2.5 / 1_000_000, output: 10 / 1_000_000 } },
  rank: 3,
  logoFile: 'openai.svg',
  deprecationDate: '2027-01-01',
  replacedBy: 'gpt-5',
};

function imageModel(id: ImageModels): ModelInfo {
  return {
    id,
    type: 'image',
    name: id,
    backend: ModelBackend.OpenAI,
    contextWindow: 0,
    max_tokens: 0,
    supportsImageVariation: false,
    pricing: {},
    image: getImageModelCapabilities(id),
  };
}

describe('toPublicModel', () => {
  it('projects a text model to snake_case and drops internal catalog fields', () => {
    const projected = project(textModel);

    expect(projected).toEqual({
      id: 'gpt-4o',
      name: 'GPT-4o',
      type: 'text',
      backend: 'openai',
      description: null,
      context_window: 128_000,
      max_output_tokens: 16_384,
      supports_streaming: true,
      supports_thinking: false,
      reasons_within_output_budget: false,
      reasoning_efforts: [],
      supports_tools: true,
      supports_tool_search: false,
      supports_tool_changes: false,
      supports_assistant_prefill: true,
      supports_vision: true,
      deprecation_date: '2027-01-01',
      replaced_by: 'gpt-5',
      image: null,
      credits_per_1m_tokens: {
        input: 2.5 * CREDITS_PER_USD_COST,
        output: 10 * CREDITS_PER_USD_COST,
        cached_input: 0.25 * CREDITS_PER_USD_COST,
      },
    });
    expect(PublicModelSchema.strict().safeParse(projected).success).toBe(true);
  });

  it('publishes the billed rate with decimals, from the base tier, honouring an explicit cache_read', () => {
    const projected = project({
      ...textModel,
      pricing: {
        200_000: { input: 0.1 / 1_000_000, output: 0.4 / 1_000_000, cache_read: 0.025 / 1_000_000 },
        1_000_000: { input: 1 / 1_000_000, output: 4 / 1_000_000 },
      },
    });

    expect(projected.credits_per_1m_tokens).toEqual({
      input: 0.1 * CREDITS_PER_USD_COST,
      output: 0.4 * CREDITS_PER_USD_COST,
      cached_input: 0.025 * CREDITS_PER_USD_COST,
    });
  });

  it.each([
    ['Gemini', ModelBackend.Gemini, 'gemini-2.5-pro'],
    ['xAI', ModelBackend.XAI, 'grok-4.5'],
  ])('publishes the explicit cached_input on %s, whose adapter forwards cache reads at it', (_label, backend, id) => {
    const projected = project({
      ...textModel,
      id: id as ModelInfo['id'],
      backend,
      pricing: { 200_000: { input: 2 / 1_000_000, output: 6 / 1_000_000, cache_read: 0.5 / 1_000_000 } },
    });

    expect(projected.credits_per_1m_tokens?.cached_input).toBe(0.5 * CREDITS_PER_USD_COST);
  });

  it.each([
    ['a Gemini model with no published cache rate', ModelBackend.Gemini, 'gemini-3-pro-preview', undefined],
    ['an xAI model with no published cache rate', ModelBackend.XAI, 'grok-3', undefined],
    ['a non-Claude Bedrock model', ModelBackend.Bedrock, 'moonshotai.kimi-k2-thinking', 0.5 / 1_000_000],
  ])(
    'publishes a null cached_input on %s, whose cache reads settle at the input rate',
    (_label, backend, id, cacheRead) => {
      const projected = project({
        ...textModel,
        id: id as ModelInfo['id'],
        backend,
        pricing: { 200_000: { input: 2 / 1_000_000, output: 6 / 1_000_000, cache_read: cacheRead } },
      });

      expect(projected.credits_per_1m_tokens).toEqual({
        input: 2 * CREDITS_PER_USD_COST,
        output: 6 * CREDITS_PER_USD_COST,
        cached_input: null,
      });
      expect(PublicModelSchema.strict().safeParse(projected).success).toBe(true);
    }
  );

  it('publishes cached_input for Claude on Bedrock, whose cache reads settle separately', () => {
    const projected = project({
      ...textModel,
      id: 'global.anthropic.claude-opus-5-5' as ModelInfo['id'],
      backend: ModelBackend.Bedrock,
      pricing: { 1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
    });

    expect(projected.credits_per_1m_tokens?.cached_input).toBe(0.5 * CREDITS_PER_USD_COST);
  });

  it.each([
    ['an empty pricing map', {}],
    ['an all-zero tier', { 128_000: { input: 0, output: 0 } }],
  ])('publishes null, not 0, for a text model with %s', (_label, pricing) => {
    const projected = project({ ...textModel, pricing });

    expect(projected.credits_per_1m_tokens).toBeNull();
    expect(PublicModelSchema.strict().safeParse(projected).success).toBe(true);
  });

  it('publishes zeros for a model that is deliberately free to run', () => {
    const projected = project({ ...textModel, freeToRun: true, pricing: { 0: { input: 0, output: 0 } } });

    expect(projected.credits_per_1m_tokens).toEqual({ input: 0, output: 0, cached_input: 0 });
  });

  it('publishes the reasoning behaviour it is given', () => {
    const projected = toPublicModel(textModel, { reasonsWithinOutputBudget: true, reasoningEfforts: ['low', 'high'] });

    expect(projected).toMatchObject({ reasons_within_output_budget: true, reasoning_efforts: ['low', 'high'] });
    expect(PublicModelSchema.strict().safeParse(projected).success).toBe(true);
  });

  it.each([
    ['Claude Opus 5.5 direct', ModelBackend.Anthropic, 'claude-opus-5-5', true, true],
    ['Claude Sonnet 5 on Bedrock', ModelBackend.Bedrock, 'global.anthropic.claude-sonnet-5', true, false],
    ['Claude Opus 4.1', ModelBackend.Anthropic, 'claude-opus-4-1-20250805', false, false],
    ['GPT-4o', ModelBackend.OpenAI, 'gpt-4o', false, false],
  ])('publishes native tool search and tool changes for %s', (_label, backend, id, toolSearch, toolChanges) => {
    const projected = project({ ...textModel, id: id as ModelInfo['id'], backend });

    expect(projected).toMatchObject({ supports_tool_search: toolSearch, supports_tool_changes: toolChanges });
  });

  it('publishes assistant prefill support with a true default and documented Claude exceptions', () => {
    expect(project(textModel).supports_assistant_prefill).toBe(true);
    expect(
      project({ ...textModel, id: 'claude-haiku-5-5' as ModelInfo['id'], backend: ModelBackend.Anthropic })
        .supports_assistant_prefill
    ).toBe(false);
  });

  it('publishes null on image models, which are not priced per token', () => {
    expect(project(imageModel(ImageModels.GPT_IMAGE_1)).credits_per_1m_tokens).toBeNull();
  });

  it.each(Object.values(ImageModels))('produces a schema-valid image block for %s', id => {
    const projected = project(imageModel(id));

    expect(projected.image).not.toBeNull();
    expect(PublicModelSchema.safeParse(projected).success).toBe(true);
  });

  it('renames every sizing kind and its fields', () => {
    const kinds = new Set(Object.values(ImageModels).map(id => project(imageModel(id)).image?.sizing.kind));

    // Guards the switch: a new ImageSizing kind must be mapped, not leak through camelCase.
    for (const kind of kinds) expect(kind).toMatch(/^[a-z_]+$/);
    expect(project(imageModel(ImageModels.GPT_IMAGE_2)).image?.sizing).toMatchObject({
      kind: 'constrained',
      auto_size: 'auto',
      constraints: { max_edge: 3840, edge_multiple: 16 },
    });
  });
});

describe('listModelsContract example', () => {
  const example = listModelsContract.responses[200].example as { data: { id: string; image: unknown }[] };

  it('matches the published response schema', () => {
    expect(ListModelsResponseSchema.safeParse(example).success).toBe(true);
  });

  it("advertises gpt-image-1's real image block, so the docs cannot drift from the request rules", () => {
    expect(example.data.find(model => model.id === 'gpt-image-1')?.image).toEqual(
      project(imageModel(ImageModels.GPT_IMAGE_1)).image
    );
  });

  it("advertises claude-sonnet-5's real tool capability flags", () => {
    const row = example.data.find(model => model.id === 'claude-sonnet-5');
    const projected = project({
      ...textModel,
      id: 'claude-sonnet-5' as ModelInfo['id'],
      backend: ModelBackend.Anthropic,
    });

    expect(row).toMatchObject({
      supports_tool_search: projected.supports_tool_search,
      supports_tool_changes: projected.supports_tool_changes,
      supports_assistant_prefill: projected.supports_assistant_prefill,
    });
  });
});
