import { describe, expect, it } from 'vitest';
import { MAX_RENDERER_NOTE_LENGTH, MAX_RENDERER_NOTES, rendererNotes } from './rendererNotes';

describe('rendererNotes', () => {
  it('passes a list of strings through', () => {
    expect(rendererNotes(['part: lid'])).toEqual(['part: lid']);
  });

  it('drops anything that is not a non-empty string list', () => {
    expect(rendererNotes(undefined)).toBeUndefined();
    expect(rendererNotes('part: lid')).toBeUndefined();
    expect(rendererNotes([1, null, '  '])).toBeUndefined();
    expect(rendererNotes(['a', 2, 'b'])).toEqual(['a', 'b']);
  });

  it('caps how many notes and how long each may be', () => {
    const notes = rendererNotes(Array.from({ length: 10 }, () => 'x'.repeat(MAX_RENDERER_NOTE_LENGTH + 5)));
    expect(notes).toHaveLength(MAX_RENDERER_NOTES);
    expect(notes?.[0]).toHaveLength(MAX_RENDERER_NOTE_LENGTH);
  });
});
