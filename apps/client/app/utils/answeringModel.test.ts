import { describe, it, expect } from 'vitest';
import { answeringModelLabel } from './answeringModel';

const names: Record<string, string> = {
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
};
const displayName = (id: string) => names[id] ?? id;

describe('answeringModelLabel', () => {
  it('reply metadata names the model that answered, and the one it replaced', () => {
    const promptMeta = { model: { name: 'gemini-3.5-flash' }, redirectedFrom: 'gemini-2.5-pro' };

    expect(answeringModelLabel(promptMeta, displayName)).toEqual({
      label: 'Gemini 3.5 Flash',
      replaces: 'Gemini 2.5 Pro',
    });
  });

  it('labels the model alone when nothing replaced it', () => {
    expect(answeringModelLabel({ model: { name: 'gemini-2.5-pro' } }, displayName)).toEqual({
      label: 'Gemini 2.5 Pro',
    });
  });

  it('returns null when no model was recorded', () => {
    expect(answeringModelLabel(undefined, displayName)).toBeNull();
    expect(answeringModelLabel({}, displayName)).toBeNull();
  });
});
