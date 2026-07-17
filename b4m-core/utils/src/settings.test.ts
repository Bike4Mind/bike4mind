import { describe, it, expect, vi } from 'vitest';
import { getSettingsValue, getSettingByName } from './settings';
import { AdminSettingsCache } from './cache/AdminSettingsCache';
import { Logger } from '@bike4mind/observability';

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

  it('does NOT apply blank->default to a non-string setting - a stored boolean false still wins', () => {
    // The fix is guarded by a strict `parsed.data === ''`, which only a string schema can produce.
    // A stored boolean `false` must be returned as-is, not collapsed to the default. This pins that
    // guard: a future `!parsed.data` simplification would re-open the fail-open bug (false -> default).
    expect(getSettingsValue('EnableArtifacts', { EnableArtifacts: false }, true)).toBe(false);
    expect(getSettingsValue('EnableArtifacts', {}, true)).toBe(true);
  });
});

// Regression: a setting stored as boolean `false` (e.g. an admin-disabled defaultValue:true
// flag) must come back as `false`, not `null`. The old `|| null` collapsed it, letting callers
// fall back to the default and silently re-enable a disabled flag (fail-open).
const repoReturning = (settingValue: unknown) => ({
  findBySettingName: vi.fn().mockResolvedValue(settingValue === undefined ? null : { settingName: 'k', settingValue }),
});

describe('getSettingByName - stored boolean false survives the round-trip', () => {
  it('skipCache path returns false, not null', async () => {
    const db = { adminSettings: repoReturning(false) };
    const v: unknown = await getSettingByName('EnableQuestMaster', db, { skipCache: true });
    expect(v).toBe(false);
  });

  it('skipCache path returns null when the setting is absent', async () => {
    const db = { adminSettings: repoReturning(undefined) };
    const v: unknown = await getSettingByName('EnableQuestMaster', db, { skipCache: true });
    expect(v).toBeNull();
  });

  it('cached path (AdminSettingsCache) returns false, not null', async () => {
    const cache = new AdminSettingsCache(new Logger());
    // Unique name so the module-scope-free instance cache doesn't collide with other tests.
    const db = { adminSettings: repoReturning(false) };
    const v: unknown = await cache.getSettingByName('EnableFalseFlagRegression', db);
    expect(v).toBe(false);
  });
});
