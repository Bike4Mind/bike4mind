import { describe, expect, it } from 'vitest';
import { formatModelName } from './configCommands';

describe('formatModelName', () => {
  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['global.anthropic.claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-opus-5', 'Claude Opus 5'],
  ])('names %s as %s', (modelId, name) => {
    expect(formatModelName(modelId)).toBe(name);
  });

  it('falls back to the raw id for an unknown model', () => {
    expect(formatModelName('some-new-model')).toBe('some-new-model');
  });
});
