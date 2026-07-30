import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { matchModel } from './matchModel';

const model = (id: string, name: string): ModelInfo =>
  ({ id, name, type: 'text', backend: 'openai', contextWindow: 128000, max_tokens: 4096 }) as unknown as ModelInfo;

const models: ModelInfo[] = [
  model('claude-opus-4-8', 'Claude Opus 4.8'),
  model('claude-sonnet-5', 'Claude Sonnet 5'),
  model('gpt-4.1-mini', 'GPT-4.1 mini'),
];

describe('matchModel', () => {
  it('returns none for an empty query', () => {
    expect(matchModel(models, '   ')).toEqual({ kind: 'none' });
  });

  it('returns none when nothing matches', () => {
    expect(matchModel(models, 'gemini')).toEqual({ kind: 'none' });
  });

  it('matches an exact id case-insensitively', () => {
    const result = matchModel(models, 'GPT-4.1-MINI');
    expect(result).toEqual({ kind: 'single', model: models[2] });
  });

  it('ignores surrounding whitespace on the query', () => {
    expect(matchModel(models, '  opus  ')).toEqual({ kind: 'single', model: models[0] });
    expect(matchModel(models, '\tclaude sonnet 5\n')).toEqual({ kind: 'single', model: models[1] });
  });

  it('matches an exact name case-insensitively', () => {
    const result = matchModel(models, 'claude sonnet 5');
    expect(result).toEqual({ kind: 'single', model: models[1] });
  });

  it('resolves a unique substring to a single model', () => {
    const result = matchModel(models, 'opus');
    expect(result).toEqual({ kind: 'single', model: models[0] });
  });

  it('returns all matches when a substring is ambiguous', () => {
    const result = matchModel(models, 'claude');
    expect(result).toEqual({ kind: 'multiple', models: [models[0], models[1]] });
  });

  it('prefers an exact match over broader substring matches', () => {
    const withOverlap = [model('sonnet', 'Sonnet'), model('sonnet-5', 'Sonnet 5')];
    // 'sonnet' is a substring of both, but it exactly equals the first model's id.
    expect(matchModel(withOverlap, 'sonnet')).toEqual({ kind: 'single', model: withOverlap[0] });
  });
});
