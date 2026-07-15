import { describe, it, expect } from 'vitest';
import { getSettingsValue } from './settings';

/**
 * Regression coverage for the "cleared string setting must revert to the built-in default" contract.
 *
 * A cleared admin setting is stored as an empty string '', which passes `z.string()` validation, so
 * the resolver used to return '' verbatim - silently stripping prompts like ArtifactEmissionPrompt /
 * HelpCenterPrompt from completions even though every such setting's description promises "clearing
 * reverts to the built-in default". getSettingsValue now treats a blank stored value as "use the
 * default" WHEN the caller passed one, while leaving '' intact for callers that omit a default (a
 * blank value is legitimate there, e.g. FormatPromptTemplate).
 */
describe('getSettingsValue - blank string reverts to a provided default', () => {
  const DEFAULT = 'BUILT_IN_DEFAULT_PROMPT';

  it('returns the provided default when the stored value is an empty string', () => {
    expect(getSettingsValue('ArtifactEmissionPrompt', { ArtifactEmissionPrompt: '' }, DEFAULT)).toBe(DEFAULT);
  });

  it('returns the provided default when the setting is unset (key absent)', () => {
    expect(getSettingsValue('ArtifactEmissionPrompt', {}, DEFAULT)).toBe(DEFAULT);
  });

  it('returns a real stored value unchanged (a non-blank custom value wins over the default)', () => {
    expect(getSettingsValue('ArtifactEmissionPrompt', { ArtifactEmissionPrompt: 'custom prompt' }, DEFAULT)).toBe(
      'custom prompt'
    );
  });

  it('applies the same blank->default behavior to HelpCenterPrompt', () => {
    expect(getSettingsValue('HelpCenterPrompt', { HelpCenterPrompt: '' }, DEFAULT)).toBe(DEFAULT);
  });

  it('keeps an empty string when NO default is provided (blank is a legitimate value here)', () => {
    // No third arg: a cleared FormatPromptTemplate stays '' (its empty default is meaningful).
    expect(getSettingsValue('FormatPromptTemplate', { FormatPromptTemplate: '' })).toBe('');
  });
});
