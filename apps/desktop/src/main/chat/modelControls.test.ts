import { ChatModels, MAX_THINKING_BUDGET_TOKENS } from '@bike4mind/common';
import { effectiveControls, requestGeneration } from '@shared/generation';
import { describe, expect, it } from 'vitest';
import { hostedControls, modelfileParameter, ollamaControls, openAICompatibleControls } from './modelControls';

const MODELFILE = ['temperature 0.6', 'top_k 20', 'num_predict 4096', 'stop "<|im_end|>"'].join('\n');

describe('modelfileParameter', () => {
  it('reads a numeric PARAMETER line and ignores the rest', () => {
    expect(modelfileParameter(MODELFILE, 'temperature')).toBe(0.6);
    expect(modelfileParameter(MODELFILE, 'top_k')).toBe(20);
    expect(modelfileParameter(MODELFILE, 'top_p')).toBeUndefined();
    expect(modelfileParameter(MODELFILE, 'stop')).toBeUndefined();
    expect(modelfileParameter(undefined, 'temperature')).toBeUndefined();
  });
});

describe('ollamaControls', () => {
  it('offers every sampling option with the Modelfile value, else what Ollama applies', () => {
    const controls = ollamaControls({ inspected: true, parameters: MODELFILE, contextWindow: 32_768 });
    expect(controls.temperature).toEqual({ min: 0, max: 2, step: 0.05, default: 0.6, scope: 'request' });
    expect(controls.topK?.default).toBe(20);
    expect(controls.topP?.default).toBe(0.9);
    expect(controls.minP?.default).toBe(0);
    expect(controls.repeatPenalty?.default).toBe(1.1);
    expect(controls.maxOutputTokens).toEqual({ min: 256, max: 32_768, step: 256, default: 4096, scope: 'request' });
    expect(controls).not.toHaveProperty('effort');
    expect(controls).not.toHaveProperty('thinkingBudgetTokens');
  });

  it('states no defaults before the model is inspected', () => {
    const controls = ollamaControls({ inspected: false, contextWindow: 8192 });
    expect(Object.keys(controls).sort()).toEqual(
      ['maxOutputTokens', 'minP', 'repeatPenalty', 'temperature', 'topK', 'topP'].sort()
    );
    expect(Object.values(controls).some(control => 'default' in control)).toBe(false);
  });

  it('lists the think levels a template names, and none for an on/off thinker', () => {
    expect(
      ollamaControls({ inspected: true, thinkingValues: ['low', 'medium', 'high'], contextWindow: 8192 }).effort
    ).toEqual({ levels: ['low', 'medium', 'high'], scope: 'request' });
    expect(ollamaControls({ inspected: true, thinkingValues: [true, false], contextWindow: 8192 })).not.toHaveProperty(
      'effort'
    );
  });
});

describe('openAICompatibleControls', () => {
  it('gives an unknown server only the OpenAI fields', () => {
    const controls = openAICompatibleControls(null, { effortLevels: false });
    expect(Object.keys(controls).sort()).toEqual(['maxOutputTokens', 'temperature', 'topP']);
    expect(controls.maxOutputTokens?.max).toBe(32_768);
  });

  it.each([
    ['lmstudio', ['maxOutputTokens', 'repeatPenalty', 'temperature', 'topK', 'topP']],
    ['llama-server', ['maxOutputTokens', 'minP', 'repeatPenalty', 'temperature', 'topK', 'topP']],
    ['vllm', ['maxOutputTokens', 'minP', 'repeatPenalty', 'temperature', 'topK', 'topP']],
  ] as const)('adds the fields %s documents', (product, fields) => {
    expect(Object.keys(openAICompatibleControls(product, { effortLevels: false })).sort()).toEqual(fields);
  });

  it('leaves half the context for the prompt and lists gpt-oss effort levels', () => {
    const controls = openAICompatibleControls('vllm', { contextWindow: 8192, effortLevels: true });
    expect(controls.maxOutputTokens?.max).toBe(4096);
    expect(controls.effort?.levels).toEqual(['low', 'medium', 'high']);
    expect(Object.values(controls).some(control => 'default' in control)).toBe(false);
  });
});

describe('hostedControls', () => {
  const budgetClaude = {
    id: ChatModels.CLAUDE_4_5_SONNET,
    backend: 'anthropic',
    canThink: true,
    maxOutputTokens: 64_000,
  };

  it('gives a budget-thinking Claude a budget, a pinned temperature and no effort', () => {
    const controls = hostedControls(budgetClaude, ['low', 'high'], true);
    expect(controls.thinkingBudgetTokens).toEqual({
      min: 1024,
      max: MAX_THINKING_BUDGET_TOKENS,
      step: 1024,
      default: 16_000,
      scope: 'request',
    });
    expect(controls.temperature).toMatchObject({ min: 0, max: 1, locked: { value: 1 } });
    expect(controls).not.toHaveProperty('effort');
  });

  it('keeps the budget plus the answer room inside the cap, which the server never clamps back to', () => {
    for (const id of [ChatModels.CLAUDE_4_OPUS, ChatModels.CLAUDE_4_1_OPUS]) {
      const controls = hostedControls({ ...budgetClaude, id, maxOutputTokens: 32_000 }, undefined, false);
      expect(controls.thinkingBudgetTokens?.max).toBe(31_000);
    }
    expect(hostedControls({ ...budgetClaude, maxOutputTokens: 2000 }, undefined, false)).not.toHaveProperty(
      'thinkingBudgetTokens'
    );
  });

  it('raises the max output floor to the budget the turn sends plus the answer room', () => {
    const controls = hostedControls(budgetClaude, undefined, false);
    expect(controls.maxOutputTokens).toMatchObject({ min: 1024, budgetHeadroom: 1000 });
    expect(requestGeneration({ maxOutputTokens: 1024 }, controls)).toEqual({ maxOutputTokens: 17_000 });
    expect(requestGeneration({ maxOutputTokens: 1024, thinkingBudgetTokens: 2048 }, controls)).toEqual({
      maxOutputTokens: 3048,
      thinkingBudgetTokens: 2048,
    });
    expect(effectiveControls(controls, { thinkingBudgetTokens: 99_999 })?.maxOutputTokens?.min).toBe(33_000);
  });

  it("offers a Claude that does not think the API's 0 to 1 temperature", () => {
    const controls = hostedControls({ ...budgetClaude, canThink: false }, undefined, false);
    expect(controls.temperature).toEqual({ min: 0, max: 1, step: 0.05, scope: 'request' });
    expect(controls).not.toHaveProperty('thinkingBudgetTokens');
  });

  it('gives an adaptive Claude no temperature and an output floor the server would raise it to', () => {
    const controls = hostedControls(
      { ...budgetClaude, id: 'claude-sonnet-4-6', thinkingStyle: 'adaptive', maxOutputTokens: 128_000 },
      ['low', 'medium', 'high', 'xhigh'],
      false
    );
    expect(controls).not.toHaveProperty('temperature');
    expect(controls).not.toHaveProperty('thinkingBudgetTokens');
    expect(controls.maxOutputTokens).toMatchObject({ min: 64_000, max: 128_000, default: 128_000 });
    expect(controls.effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('drops temperature for a model that rejects it and for a thinking Gemini', () => {
    expect(
      hostedControls({ id: ChatModels.KIMI_K2_6, backend: 'moonshot', canThink: true }, [], false)
    ).not.toHaveProperty('temperature');
    expect(
      hostedControls({ id: ChatModels.GEMINI_2_5_PRO, backend: 'gemini', canThink: true }, undefined, false)
    ).not.toHaveProperty('temperature');
    expect(
      hostedControls({ id: 'gemini-2.0-flash', backend: 'gemini', canThink: false }, undefined, false).temperature
    ).toEqual({ min: 0, max: 2, step: 0.05, scope: 'request' });
  });

  it('pins temperature at 1 for a fixed-temperature model and a max_completion_tokens thinker', () => {
    expect(
      hostedControls({ id: ChatModels.GPT5, backend: 'openai', canThink: true }, undefined, true).temperature
    ).toMatchObject({ locked: { value: 1, reason: 'This model only runs at temperature 1.' } });
    expect(
      hostedControls(
        { id: 'some-new-reasoner', backend: 'openai', canThink: true, maxCompletionTokens: true },
        undefined,
        false
      ).temperature?.locked?.value
    ).toBe(1);
  });

  it('lists the levels the server publishes, in order, else the old four for a known reasoning model', () => {
    const gpt = { id: ChatModels.GPT5, backend: 'openai', canThink: true };
    expect(hostedControls(gpt, ['xhigh', 'none', 'low'], true).effort?.levels).toEqual(['none', 'low', 'xhigh']);
    expect(hostedControls(gpt, undefined, true).effort?.levels).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(hostedControls(gpt, undefined, false)).not.toHaveProperty('effort');
    expect(hostedControls(gpt, [], true)).not.toHaveProperty('effort');
  });

  it('bounds max output by the catalog cap and offers none without one', () => {
    const gpt = { id: 'gpt-4.1', backend: 'openai', canThink: false };
    expect(hostedControls({ ...gpt, maxOutputTokens: 8192 }, undefined, false).maxOutputTokens).toEqual({
      min: 1024,
      max: 8192,
      step: 256,
      default: 8192,
      scope: 'request',
    });
    expect(hostedControls(gpt, undefined, false)).not.toHaveProperty('maxOutputTokens');
  });
});
