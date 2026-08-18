import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STALE_MODEL_PROMPT_DISMISSED_KEY,
  dismissStaleModelPrompt,
  isStaleModelPromptDismissed,
} from './staleModelPrompt';

describe('staleModelPrompt dismissal memory', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reports not dismissed for an untouched session/model pair', () => {
    expect(isStaleModelPromptDismissed('s1', 'grok-3')).toBe(false);
  });

  it('remembers a dismissal', () => {
    dismissStaleModelPrompt('s1', 'grok-3');
    expect(isStaleModelPromptDismissed('s1', 'grok-3')).toBe(true);
  });

  it('scopes the dismissal to the session and to the model', () => {
    dismissStaleModelPrompt('s1', 'grok-3');
    expect(isStaleModelPromptDismissed('s2', 'grok-3')).toBe(false);
    expect(isStaleModelPromptDismissed('s1', 'gpt-4')).toBe(false);
  });

  it('caps stored dismissals and drops the oldest first', () => {
    for (let i = 0; i < 205; i++) {
      dismissStaleModelPrompt(`s${i}`, 'grok-3');
    }
    const stored = JSON.parse(localStorage.getItem(STALE_MODEL_PROMPT_DISMISSED_KEY)!);
    expect(stored).toHaveLength(200);
    expect(isStaleModelPromptDismissed('s0', 'grok-3')).toBe(false);
    expect(isStaleModelPromptDismissed('s204', 'grok-3')).toBe(true);
  });

  it('does not duplicate an entry that is dismissed twice', () => {
    dismissStaleModelPrompt('s1', 'grok-3');
    dismissStaleModelPrompt('s1', 'grok-3');
    expect(JSON.parse(localStorage.getItem(STALE_MODEL_PROMPT_DISMISSED_KEY)!)).toEqual(['s1::grok-3']);
  });

  it('treats corrupt stored data as no dismissals rather than throwing', () => {
    localStorage.setItem(STALE_MODEL_PROMPT_DISMISSED_KEY, '{not json');
    expect(isStaleModelPromptDismissed('s1', 'grok-3')).toBe(false);
    expect(() => dismissStaleModelPrompt('s1', 'grok-3')).not.toThrow();
    expect(isStaleModelPromptDismissed('s1', 'grok-3')).toBe(true);
  });

  it('degrades to not-dismissed when localStorage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => dismissStaleModelPrompt('s1', 'grok-3')).not.toThrow();
    expect(isStaleModelPromptDismissed('s1', 'grok-3')).toBe(false);
  });
});
