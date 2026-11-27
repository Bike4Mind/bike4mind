// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { skillTemplateFreeRunInputKey } from '@bike4mind/common';
import { clearFreeRunInput, readFreeRunInput, skillTemplateGoal } from './skillTemplateTry';

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('skillTemplateGoal', () => {
  it('puts the prompt after the slash command', () => {
    expect(skillTemplateGoal('article-bullets', ' Summarize this ')).toBe('/article-bullets Summarize this');
  });

  it('leaves the cursor after the command when there is no prompt', () => {
    expect(skillTemplateGoal('article-bullets', '  ')).toBe('/article-bullets ');
  });
});

describe('free-run input', () => {
  it('reads and clears the per-slug key', () => {
    window.localStorage.setItem(skillTemplateFreeRunInputKey('a'), 'text for a');
    expect(readFreeRunInput('a')).toBe('text for a');
    expect(readFreeRunInput('b')).toBe('');
    clearFreeRunInput('a');
    expect(readFreeRunInput('a')).toBe('');
  });

  it('treats blocked storage as no text', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readFreeRunInput('a')).toBe('');
    expect(() => clearFreeRunInput('a')).not.toThrow();
  });
});
