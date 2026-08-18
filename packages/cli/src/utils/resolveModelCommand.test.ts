import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { resolveModelCommand } from './resolveModelCommand';

const model = (id: string, name: string): ModelInfo =>
  ({ id, name, type: 'text', backend: 'openai', contextWindow: 128000, max_tokens: 4096 }) as unknown as ModelInfo;

const models: ModelInfo[] = [
  model('claude-opus-4-8', 'Claude Opus 4.8'),
  model('claude-sonnet-5', 'Claude Sonnet 5'),
  model('gpt-4.1-mini', 'GPT-4.1 mini'),
];

describe('resolveModelCommand', () => {
  it('reports no-models when the list is empty', () => {
    expect(resolveModelCommand([], ['opus'], 'gpt-4.1-mini')).toEqual({ kind: 'no-models' });
  });

  it('opens the picker when no argument is given', () => {
    expect(resolveModelCommand(models, [], 'gpt-4.1-mini')).toEqual({ kind: 'open-picker' });
  });

  it('reports no-match for an unknown model', () => {
    expect(resolveModelCommand(models, ['gemini'], 'gpt-4.1-mini')).toEqual({ kind: 'no-match', query: 'gemini' });
  });

  it('reports ambiguous when a substring matches several models', () => {
    expect(resolveModelCommand(models, ['claude'], 'gpt-4.1-mini')).toEqual({
      kind: 'ambiguous',
      models: [models[0], models[1]],
    });
  });

  it('joins multi-word arguments before matching', () => {
    expect(resolveModelCommand(models, ['claude', 'sonnet', '5'], 'gpt-4.1-mini')).toEqual({
      kind: 'switch',
      model: models[1],
    });
  });

  it('switches to an unambiguous match that differs from the current model', () => {
    expect(resolveModelCommand(models, ['opus'], 'gpt-4.1-mini')).toEqual({ kind: 'switch', model: models[0] });
  });

  // The core M1 regression guard: the arbiter is the *live* current model, so
  // asking for the model already in use is a noop even if config diverged.
  it('reports already-current when the match equals the live current model', () => {
    expect(resolveModelCommand(models, ['opus'], 'claude-opus-4-8')).toEqual({
      kind: 'already-current',
      model: models[0],
    });
  });

  it('treats an undefined current model as a real switch, never a noop', () => {
    expect(resolveModelCommand(models, ['opus'], undefined)).toEqual({ kind: 'switch', model: models[0] });
  });
});
