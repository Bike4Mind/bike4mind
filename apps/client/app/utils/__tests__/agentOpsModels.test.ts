import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { ModelBackend } from '@bike4mind/common';
import { agentOpsModelOptions, agentOpsModelRejection, isSelectableAgentOpsModel } from '../agentOpsModels';

/**
 * Agent-ops used to keep its own model lists -- an allowlist in the endpoint, a picker array in
 * AgentOpsTab, and a Mongoose enum -- and they drifted: the picker offered `grok-3` labelled
 * "xAI Latest" months after Grok 4.5 superseded it, while `grok-4.5` was absent from the
 * allowlist and so could not be saved at all. Both sides now project the same catalog through
 * these helpers, so the tests below pin the projection rather than a list of model IDs.
 */

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'name'>): ModelInfo =>
  ({
    type: 'text',
    backend: ModelBackend.Anthropic,
    contextWindow: 200_000,
    max_tokens: 8192,
    pricing: {},
    supportsImageVariation: false,
    ...over,
  }) as ModelInfo;

describe('agentOpsModelOptions', () => {
  it('offers text models and drops image, video and speech models', () => {
    const options = agentOpsModelOptions([
      model({ id: 'claude-opus-5', name: 'Claude 5 Opus' }),
      model({ id: 'dall-e-3', name: 'DALL-E 3', type: 'image' }),
      model({ id: 'whisper-1', name: 'Whisper', type: 'speech-to-text' }),
    ]);

    expect(options.map(m => m.id)).toEqual(['claude-opus-5']);
  });

  it('orders by rank, then name, with unranked models last', () => {
    const options = agentOpsModelOptions([
      model({ id: 'unranked-b', name: 'Zeta' }),
      model({ id: 'third', name: 'Third', rank: 5 }),
      model({ id: 'unranked-a', name: 'Alpha' }),
      model({ id: 'first', name: 'First', rank: 1 }),
    ]);

    expect(options.map(m => m.id)).toEqual(['first', 'third', 'unranked-a', 'unranked-b']);
  });

  it('keeps disabled models so the picker can explain their absence', () => {
    const options = agentOpsModelOptions([model({ id: 'gated', name: 'Gated', disabled: true })]);

    expect(options.map(m => m.id)).toEqual(['gated']);
  });
});

describe('isSelectableAgentOpsModel', () => {
  const catalog = [
    model({ id: 'grok-4.5', name: 'Grok 4.5' }),
    model({ id: 'gated', name: 'Gated', disabled: true }),
    model({ id: 'dall-e-3', name: 'DALL-E 3', type: 'image' }),
  ];

  it('accepts a live text model the picker offers', () => {
    expect(isSelectableAgentOpsModel(catalog, 'grok-4.5')).toBe(true);
  });

  it('rejects a model absent from the catalog', () => {
    // getAvailableModels drops deprecated IDs, so `grok-3` never reaches this helper.
    expect(isSelectableAgentOpsModel(catalog, 'grok-3')).toBe(false);
  });

  it('rejects a disabled model even though the picker lists it', () => {
    expect(isSelectableAgentOpsModel(catalog, 'gated')).toBe(false);
  });

  it('rejects a non-text model', () => {
    expect(isSelectableAgentOpsModel(catalog, 'dall-e-3')).toBe(false);
  });

  it('accepts exactly what the picker offers as enabled', () => {
    const offered = agentOpsModelOptions(catalog)
      .filter(m => !m.disabled)
      .map(m => m.id);

    expect(offered.every(id => isSelectableAgentOpsModel(catalog, id))).toBe(true);
  });
});

describe('agentOpsModelRejection', () => {
  const catalog = [
    model({ id: 'grok-4.5', name: 'Grok 4.5' }),
    model({ id: 'gated', name: 'Gated', disabledReason: 'Requires an xAI key', disabled: true }),
    model({ id: 'quiet', name: 'Quiet', disabled: true }),
  ];

  it('gives no reason for a selectable model', () => {
    expect(agentOpsModelRejection(catalog, 'grok-4.5')).toBeNull();
  });

  it("surfaces a disabled model's own reason rather than blaming the input", () => {
    expect(agentOpsModelRejection(catalog, 'gated')).toBe('Requires an xAI key');
  });

  it('names the model when it is disabled without a reason', () => {
    expect(agentOpsModelRejection(catalog, 'quiet')).toContain('Quiet');
  });

  it('reports an unknown id as an invalid model', () => {
    expect(agentOpsModelRejection(catalog, 'nonesuch')).toBe('Invalid LLM model specified');
  });
});
