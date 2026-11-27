import { describe, expect, it } from 'vitest';
import { titleFromStudioPrompt } from './studioAssetTitle';

describe('titleFromStudioPrompt', () => {
  it('removes Markdown and preparation labels', () => {
    expect(titleFromStudioPrompt('## Draft: Image prompt: **A bicycle beside a lake**', 'image')).toBe(
      'A bicycle beside a lake'
    );
  });

  it('bounds titles and retains a fallback for empty prompts', () => {
    expect(titleFromStudioPrompt('one two three four five six seven eight nine', 'image')).toBe(
      'One two three four five six seven eight'
    );
    expect(titleFromStudioPrompt('Draft:', 'image')).toBe('image');
  });
});
