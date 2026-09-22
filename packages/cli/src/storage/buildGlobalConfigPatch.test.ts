import { describe, it, expect } from 'vitest';
import { buildGlobalConfigPatch } from './buildGlobalConfigPatch';
import type { CliConfig } from './types';

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    version: '1.0.0',
    userId: 'u',
    defaultModel: 'claude-sonnet-4-6',
    toolApiKeys: {},
    mcpServers: [],
    preferences: {
      temperature: 0.7,
      autoSave: true,
      theme: 'dark',
      exportFormat: 'markdown',
      maxIterations: null,
    },
    tools: { enabled: [], disabled: [], config: {} },
    ...overrides,
  };
}

describe('buildGlobalConfigPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    const prev = makeConfig();
    const next = makeConfig();
    expect(buildGlobalConfigPatch(prev, next)).toEqual({});
  });

  it('emits only the single preference key the user changed', () => {
    const prev = makeConfig();
    const next = makeConfig({ preferences: { ...prev.preferences, temperature: 0.2 } });
    const patch = buildGlobalConfigPatch(prev, next);
    expect(patch).toEqual({ preferences: { temperature: 0.2 } });
  });

  it('emits only defaultModel when only the model changed', () => {
    const prev = makeConfig();
    const next = makeConfig({ defaultModel: 'claude-opus-4-8' });
    const patch = buildGlobalConfigPatch(prev, next);
    expect(patch).toEqual({ defaultModel: 'claude-opus-4-8' });
  });

  // The laundering guard: a repo layer injected these into the merged config the
  // user is editing, but the user never touched them (prev === next for them), so
  // they must NOT appear in the patch. A regression that passed the full merged
  // config would leak them into the global layer and fail here.
  it('omits repo-injected fields the user did not touch', () => {
    const repoInjected = makeConfig({
      defaultModel: 'repo-forced-model',
      preferences: {
        temperature: 0.7,
        autoSave: true,
        theme: 'dark',
        exportFormat: 'markdown',
        maxIterations: null,
        promptVariant: 'minimal',
      },
    });
    // User edits ONE preference; everything else equals the repo-merged seed.
    const next = makeConfig({
      defaultModel: 'repo-forced-model',
      preferences: { ...repoInjected.preferences, autoSave: false },
    });
    const patch = buildGlobalConfigPatch(repoInjected, next);
    expect(patch).toEqual({ preferences: { autoSave: false } });
    expect(patch.defaultModel).toBeUndefined();
    expect(patch.preferences?.promptVariant).toBeUndefined();
  });

  it('emits the whole features object when any feature changed', () => {
    const prev = makeConfig({ features: { tavern: true, hearth: true } });
    const next = makeConfig({ features: { tavern: false, hearth: true } });
    const patch = buildGlobalConfigPatch(prev, next);
    // Whole-object on purpose: save()/mergeFeatures needs the complete desired
    // set to detect removals. See buildGlobalConfigPatch's docstring.
    expect(patch.features).toEqual({ tavern: false, hearth: true });
  });

  it('omits features when unchanged', () => {
    const prev = makeConfig({ features: { tavern: true } });
    const next = makeConfig({ features: { tavern: true } });
    expect(buildGlobalConfigPatch(prev, next).features).toBeUndefined();
  });

  it('treats an undefined prev as everything-changed', () => {
    const next = makeConfig({ defaultModel: 'm' });
    const patch = buildGlobalConfigPatch(undefined, next);
    expect(patch.defaultModel).toBe('m');
    expect(patch.preferences).toEqual(next.preferences);
  });
});
