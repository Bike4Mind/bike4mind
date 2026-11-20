import { describe, expect, it } from 'vitest';
import { draftFactsOf, draftTokensOf, ollamaDraft, ollamaLoadFields, type DraftFacts } from './loadOptions';

const MTP: DraftFacts = { mtpLayers: 1, draftLayer: false };
const DRAFT_LAYER: DraftFacts = { mtpLayers: 0, draftLayer: true };
const PLAIN: DraftFacts = { mtpLayers: 0, draftLayer: false };

describe('ollamaDraft', () => {
  it("runs a model at its Modelfile's draft count, else 4 with a draft layer and off with only an MTP head", () => {
    expect(ollamaDraft({ ...MTP, parameters: 'draft_num_predict 3\ntemperature 0.6' })).toEqual({ modelDefault: 3 });
    expect(ollamaDraft(DRAFT_LAYER)).toEqual({ modelDefault: 4 });
    expect(ollamaDraft(MTP)).toEqual({ modelDefault: 0 });
    expect(ollamaDraft({ ...MTP, parameters: 'draft_num_predict 2.5' })).toEqual({ modelDefault: 0 });
  });

  it('offers nothing for a model without an MTP head or a draft layer', () => {
    expect(ollamaDraft({ ...PLAIN, parameters: 'draft_num_predict 3' })).toBeUndefined();
  });
});

describe('draftFactsOf', () => {
  it("reads the MTP head from the arch's nextn layers and a draft layer from the Modelfile", () => {
    expect(
      draftFactsOf({ model_info: { 'qwen35.nextn_predict_layers': 1, 'qwen35.context_length': 262144 } })
    ).toMatchObject({ mtpLayers: 1, draftLayer: false });
    expect(draftFactsOf({ model_info: { 'llama.context_length': 8192 } })).toMatchObject({
      mtpLayers: 0,
      draftLayer: false,
    });
    expect(
      draftFactsOf({ modelfile: 'FROM /models/blobs/sha256-aaaa\nDRAFT /models/blobs/sha256-bbbb\n' }).draftLayer
    ).toBe(true);
  });
});

describe('draftTokensOf', () => {
  it("is the set count, else the model's own, and 0 for a model that cannot speculate", () => {
    expect(draftTokensOf({ draftTokens: 2 }, DRAFT_LAYER)).toBe(2);
    expect(draftTokensOf({}, DRAFT_LAYER)).toBe(4);
    expect(draftTokensOf({ draftTokens: 0 }, DRAFT_LAYER)).toBe(0);
    expect(draftTokensOf({ draftTokens: 2 }, PLAIN)).toBe(0);
  });
});

describe('ollamaLoadFields', () => {
  it('sends a set keep-alive on any model and a set draft count only where Ollama can speculate', () => {
    expect(ollamaLoadFields({ keepAlive: -1, draftTokens: 3 }, MTP)).toEqual({
      keepAlive: { keep_alive: -1 },
      options: { draft_num_predict: 3 },
    });
    expect(ollamaLoadFields({ keepAlive: 3600, draftTokens: 3 }, PLAIN)).toEqual({
      keepAlive: { keep_alive: 3600 },
      options: {},
    });
    expect(ollamaLoadFields({ draftTokens: 0 }, DRAFT_LAYER)).toEqual({
      keepAlive: {},
      options: { draft_num_predict: 0 },
    });
  });

  it('sends nothing for a model with none set', () => {
    expect(ollamaLoadFields({}, MTP)).toEqual({ keepAlive: {}, options: {} });
  });
});
