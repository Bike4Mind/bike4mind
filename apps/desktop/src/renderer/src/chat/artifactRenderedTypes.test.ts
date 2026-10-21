import { describe, expect, it } from 'vitest';
import { DESKTOP_ARTIFACT_PROMPT } from '../../../main/chat/artifacts/prompt';
import { RENDERED_TYPES, SOURCE_ONLY_NOTE, TYPE_LABEL } from './ArtifactCard';

/**
 * The list of types this app draws lives in three places that cannot import each other: the
 * card decides, the note explains the gap to the user, and the prompt tells the model. Any two
 * of them disagreeing is a bug the user sees - a wall of source where a picture was promised,
 * or a note pointing at the web app for something drawn right in front of them.
 */

/** The prompt's own claim, read back out of the sentence that makes it. */
function typesThePromptAdvertises(): Set<string> {
  const claim = /This app draws (.+?) artifacts as they will look/.exec(DESKTOP_ARTIFACT_PROMPT.replace(/\n/g, ' '));
  expect(claim).not.toBeNull();
  return new Set(claim![1].split(/,\s*|\s+and\s+/).map(name => name.trim()));
}

describe('what this app says it can draw', () => {
  it('promises the model exactly what the card renders', () => {
    expect(typesThePromptAdvertises()).toEqual(RENDERED_TYPES);
  });

  it('does not send the user to the web app for a type it renders here', () => {
    const overlap = [...RENDERED_TYPES].filter(type => type in SOURCE_ONLY_NOTE);
    expect(overlap).toEqual([]);
  });

  it('has a label for every type it has an opinion about', () => {
    for (const type of [...RENDERED_TYPES, ...Object.keys(SOURCE_ONLY_NOTE)]) {
      expect(TYPE_LABEL[type]).toBeTruthy();
    }
  });
});
