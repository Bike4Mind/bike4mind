import type { ChatModelOption } from '@shared/chat';
import { requestGeneration, type ModelControls } from '@shared/generation';
import { describe, expect, it } from 'vitest';
import { auxiliaryGeneration, turnEffortSetting, turnGeneration, turnThinks } from './modelDefaults';
import { ollamaControls, openAICompatibleControls } from './modelControls';

const controls: ModelControls = ollamaControls({ inspected: true, contextWindow: 32_768, thinks: true });

const qwen: ChatModelOption = {
  id: 'local:ollama:qwen3.8:27b',
  name: 'qwen3.8:27b',
  thinkingToggle: true,
  controls,
  catalogSampling: {
    thinking: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
  },
};

const gemma: ChatModelOption = {
  ...qwen,
  id: 'local:ollama:gemma4:12b-it-qat',
  catalogSampling: {
    thinking: { temperature: 1, topP: 0.95, topK: 64 },
    nonThinking: { temperature: 0.7, topP: 0.8, topK: 40 },
  },
};

describe('turnGeneration precedence', () => {
  it('sends the catalog sampling for the thinking state when nothing else is set', () => {
    expect(requestGeneration(turnGeneration(undefined, undefined, qwen, true), qwen.controls)).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 1.5,
      repeatPenalty: 1,
    });
  });

  it('seeds a turn with thinking off from the non-thinking sampling, and from nothing when the family has none', () => {
    expect(turnGeneration(undefined, undefined, gemma, false)).toEqual({ temperature: 0.7, topP: 0.8, topK: 40 });
    expect(turnGeneration(undefined, undefined, qwen, false)).toEqual({});
  });

  it('puts the model default above the catalog, and the chat override above both', () => {
    const defaults = { generation: { temperature: 0.6, topK: 30, maxOutputTokens: 4096 } };
    expect(turnGeneration(undefined, defaults, gemma, true)).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 30,
      maxOutputTokens: 4096,
    });
    expect(turnGeneration({ temperature: 0.2 }, defaults, gemma, true)).toEqual({
      temperature: 0.2,
      topP: 0.95,
      topK: 30,
      maxOutputTokens: 4096,
    });
  });

  it('sends nothing for a model with no defaults and no catalog entry', () => {
    const plain = { ...qwen, catalogSampling: undefined };
    expect(requestGeneration(turnGeneration(undefined, undefined, plain, true), plain.controls)).toEqual({});
    expect(requestGeneration(turnGeneration(undefined, {}, undefined, true), undefined)).toEqual({});
  });
});

describe('auxiliaryGeneration', () => {
  it('sends the model defaults and the non-thinking catalog sampling, never an output size', () => {
    const defaults = { generation: { temperature: 0.5, maxOutputTokens: 4096 } };
    expect(auxiliaryGeneration(defaults, gemma)).toEqual({ temperature: 0.5, topP: 0.8, topK: 40 });
    expect(auxiliaryGeneration(undefined, qwen)).toEqual({});
    expect(auxiliaryGeneration(defaults, undefined)).toEqual({});
  });

  it('uses the thinking sampling when the model always thinks or its effort has no none', () => {
    const sampling = { thinking: { temperature: 1, topP: 0.95 }, nonThinking: { temperature: 0.7, topP: 0.8 } };
    const seeded = (option: Partial<ChatModelOption>) =>
      auxiliaryGeneration(undefined, { ...qwen, catalogSampling: sampling, ...option });
    expect(seeded({ thinkingAlwaysOn: true })).toEqual({ temperature: 1, topP: 0.95 });
    const effort = (levels: ('none' | 'low' | 'high')[]) => ({
      controls: { ...controls, effort: { levels, scope: 'request' as const } },
    });
    expect(seeded(effort(['low', 'high']))).toEqual({ temperature: 1, topP: 0.95 });
    expect(seeded(effort(['none', 'low', 'high']))).toEqual({ temperature: 0.7, topP: 0.8 });
  });
});

describe('catalog sampling on an OpenAI-compatible server', () => {
  const sampling = qwen.catalogSampling;
  const compatible = (product: Parameters<typeof openAICompatibleControls>[0]): ChatModelOption => ({
    ...qwen,
    id: 'local:srv-abc123:qwen3.8:27b',
    catalogSampling: sampling,
    controls: openAICompatibleControls(product, { effortLevels: false, thinks: true }),
  });

  const sent = (option: ChatModelOption) =>
    requestGeneration(turnGeneration(undefined, undefined, option, true), option.controls);

  it('seeds a curated model and sends only the fields the server takes', () => {
    expect(sent(compatible(null))).toEqual({ temperature: 1, topP: 0.95, presencePenalty: 1.5 });
    expect(sent(compatible('llama-server'))).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 1.5,
      repeatPenalty: 1,
    });
  });
});

describe('turnThinks', () => {
  it('follows the switch on a toggle model', () => {
    expect(turnThinks('default', qwen, undefined)).toBe(true);
    expect(turnThinks('none', qwen, undefined)).toBe(false);
  });

  it('is false for a model that cannot think, and true for one that always does', () => {
    expect(turnThinks('default', { controls }, undefined)).toBe(false);
    expect(turnThinks('none', { ...qwen, thinkingAlwaysOn: true }, undefined)).toBe(true);
    expect(turnThinks('default', undefined, undefined)).toBe(false);
  });

  it('is true for a model with effort levels unless the turn sends none', () => {
    const levelled = { controls: { effort: { levels: ['low' as const, 'high' as const], scope: 'request' as const } } };
    expect(turnThinks('default', levelled, undefined)).toBe(true);
    expect(turnThinks('low', levelled, 'none')).toBe(false);
  });
});

describe('turnEffortSetting', () => {
  const levelled = { controls: { effort: { levels: ['low' as const, 'high' as const], scope: 'request' as const } } };

  it("stands the model's level in for a conversation left at default", () => {
    expect(turnEffortSetting('default', { effort: 'high' }, levelled)).toBe('high');
    expect(turnEffortSetting('low', { effort: 'high' }, levelled)).toBe('low');
  });

  it('ignores a stored level on a model that lists none', () => {
    expect(turnEffortSetting('default', { effort: 'none' }, qwen)).toBe('default');
    expect(turnEffortSetting('default', undefined, levelled)).toBe('default');
  });
});
