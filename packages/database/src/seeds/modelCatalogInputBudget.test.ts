import { describe, it, expect } from 'vitest';
import { CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS, MODEL_INFO_TYPES } from '@bike4mind/common';
import type { ModelInfo } from '@bike4mind/common';
import { collectStaticCatalogModels } from './generateModelCatalogSeed';

/**
 * safeInputWindow (ChatCompletionProcess) sizes a prompt as
 * contextWindow - reservedOutput - CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS and is deliberately not
 * clamped at zero, so a text row whose max_tokens eats its whole window makes the chat path refuse
 * to build a prompt at all. That shipped as a live failure on six rows, which is why the tables are
 * held to it here rather than at the consumption site.
 *
 * Ollama and LocalImage are absent from collectStaticCatalogModels (their listings are live server
 * calls); the Ollama row carries the same assertion in llm-adapters/src/ollamaBackend.test.ts.
 */

const describeEntry = (model: ModelInfo) =>
  `${model.id} (contextWindow ${model.contextWindow}, max_tokens ${model.max_tokens})`;

/**
 * Every ModelInfo type needs a deliberate rule. A type added to the union without one fails the
 * exhaustiveness check below instead of silently inheriting an allow.
 */
const RULE_BY_TYPE: Record<ModelInfo['type'], 'reserves-output' | 'prompt-length-limit' | 'no-prompt-assembly'> = {
  text: 'reserves-output',
  // max_tokens is the prompt-length limit on these, never an output reserve: a model that returns
  // media has no tokens to reserve, so safeInputWindow subtracts nothing for it.
  image: 'prompt-length-limit',
  video: 'prompt-length-limit',
  // Transcription never enters prompt assembly, so neither figure is a token budget.
  'speech-to-text': 'no-prompt-assembly',
};

describe('static model catalog input budget', () => {
  it('rules on every ModelInfo type, so a new type cannot inherit an allow', () => {
    expect(Object.keys(RULE_BY_TYPE).sort()).toEqual([...MODEL_INFO_TYPES].sort());
  });

  it('declares both window figures on every entry', async () => {
    // An absent figure would pass the checks below vacuously, and safeInputWindow's own fallbacks
    // (200000 / 16384) would then invent a budget the table never stated.
    const models = await collectStaticCatalogModels();
    const missing = models.filter(
      model => typeof model.contextWindow !== 'number' || typeof model.max_tokens !== 'number'
    );
    expect(missing.map(model => model.id)).toEqual([]);
  });

  it('leaves a positive input budget on every text entry', async () => {
    // Fix a failure by lowering max_tokens in the adapter table to a real output reserve, then
    // regenerating the catalog seed - the seed row overlays the literal on a deployed environment.
    const models = await collectStaticCatalogModels();
    const starved = models.filter(
      model =>
        RULE_BY_TYPE[model.type] === 'reserves-output' &&
        (model.contextWindow ?? 0) - (model.max_tokens ?? 0) - CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS <= 0
    );
    expect(starved.map(describeEntry)).toEqual([]);
  });

  it('leaves a media entry a prompt it can fill', async () => {
    const models = await collectStaticCatalogModels();
    const media = models.filter(model => RULE_BY_TYPE[model.type] === 'prompt-length-limit');

    // A prompt-length limit above the window it is measured against is a contradiction. Equality is
    // the common shape; Gemini's image rows sit below it, and both are legal.
    const overWindow = media.filter(model => (model.max_tokens ?? 0) > (model.contextWindow ?? 0));
    expect(overWindow.map(describeEntry)).toEqual([]);

    // No output is reserved for media, but the safety buffer still comes off the top.
    const starved = media.filter(model => (model.contextWindow ?? 0) - CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS <= 0);
    expect(starved.map(describeEntry)).toEqual([]);
  });
});
