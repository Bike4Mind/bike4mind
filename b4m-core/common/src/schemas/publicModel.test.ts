import { describe, expect, it } from 'vitest';
import { ImageModels, ModelBackend, type ModelInfo } from '../models';
import { getImageModelCapabilities } from '../utils/imageCapabilities';
import { listModelsContract } from '../api-contract/contracts/models.contract';
import { ListModelsResponseSchema, PublicModelSchema, toPublicModel } from './publicModel';

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
  pricing: { 0: { input: 1, output: 2 } },
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
    const projected = toPublicModel(textModel);

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
      supports_tools: true,
      supports_vision: true,
      deprecation_date: '2027-01-01',
      replaced_by: 'gpt-5',
      image: null,
    });
    expect(PublicModelSchema.strict().safeParse(projected).success).toBe(true);
  });

  it.each(Object.values(ImageModels))('produces a schema-valid image block for %s', id => {
    const projected = toPublicModel(imageModel(id));

    expect(projected.image).not.toBeNull();
    expect(PublicModelSchema.safeParse(projected).success).toBe(true);
  });

  it('renames every sizing kind and its fields', () => {
    const kinds = new Set(Object.values(ImageModels).map(id => toPublicModel(imageModel(id)).image?.sizing.kind));

    // Guards the switch: a new ImageSizing kind must be mapped, not leak through camelCase.
    for (const kind of kinds) expect(kind).toMatch(/^[a-z_]+$/);
    expect(toPublicModel(imageModel(ImageModels.GPT_IMAGE_2)).image?.sizing).toMatchObject({
      kind: 'constrained',
      auto_size: 'auto',
      constraints: { max_edge: 3840, edge_multiple: 16 },
    });
  });
});

describe('listModelsContract example', () => {
  const example = listModelsContract.responses[200].example as { data: { image: unknown }[] };

  it('matches the published response schema', () => {
    expect(ListModelsResponseSchema.safeParse(example).success).toBe(true);
  });

  it("advertises gpt-image-1's real image block, so the docs cannot drift from the request rules", () => {
    expect(example.data[0].image).toEqual(toPublicModel(imageModel(ImageModels.GPT_IMAGE_1)).image);
  });
});
