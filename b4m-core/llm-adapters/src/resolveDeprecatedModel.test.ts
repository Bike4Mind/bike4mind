import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEPRECATED_MODEL_MAP, resolveDeprecatedModelId } from './resolveDeprecatedModel';
import { XAIBackend } from './xaiBackend';

describe('resolveDeprecatedModelId', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve deprecated Bedrock model IDs', () => {
    expect(resolveDeprecatedModelId('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe(
      'global.anthropic.claude-sonnet-4-6'
    );
    expect(resolveDeprecatedModelId('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
      'global.anthropic.claude-sonnet-4-6'
    );
    expect(resolveDeprecatedModelId('us.anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(
      'global.anthropic.claude-sonnet-4-6'
    );
    expect(resolveDeprecatedModelId('anthropic.claude-3-haiku-20240307-v1:0')).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    );
    expect(resolveDeprecatedModelId('anthropic.claude-3-opus-20240229-v1:0')).toBe('global.anthropic.claude-opus-4-8');
  });

  it('should resolve deprecated Anthropic-hosted model IDs', () => {
    expect(resolveDeprecatedModelId('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('claude-3-7-sonnet-20250219')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('claude-3-opus-20240229')).toBe('claude-opus-4-8');
    expect(resolveDeprecatedModelId('claude-3-haiku-20240307')).toBe('claude-haiku-4-5-20251001');
  });

  it('should pass through unknown model IDs unchanged', () => {
    expect(resolveDeprecatedModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('gpt-4o')).toBe('gpt-4o');
    expect(resolveDeprecatedModelId('some-future-model')).toBe('some-future-model');
  });

  it('should log a warning when resolving a deprecated model', () => {
    resolveDeprecatedModelId('claude-3-5-sonnet-20241022', 'test-context');

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[model-sunset]'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('test-context'));
  });

  it('should not log a warning for non-deprecated models', () => {
    resolveDeprecatedModelId('claude-sonnet-4-6');

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should resolve superseded xAI model IDs to Grok 4.5', () => {
    expect(resolveDeprecatedModelId('grok-3')).toBe('grok-4.5');
    expect(resolveDeprecatedModelId('grok-3-fast')).toBe('grok-4.5');
    expect(resolveDeprecatedModelId('grok-2-1212')).toBe('grok-4.5');
    expect(resolveDeprecatedModelId('grok-2-vision-1212')).toBe('grok-4.5');
    expect(resolveDeprecatedModelId('grok-beta')).toBe('grok-4.5');
    expect(resolveDeprecatedModelId('grok-vision-beta')).toBe('grok-4.5');
  });

  it('should keep budget-tier xAI pins on a budget model rather than raising cost', () => {
    // grok-4.5 ($2/$6) would be a cost increase over Grok 3 Mini Fast ($0.60/$4).
    expect(resolveDeprecatedModelId('grok-3-mini-fast')).toBe('grok-3-mini');
    // grok-3-mini is current and has no cheaper equivalent, so it must pass through
    // untouched -- mapping it up would raise input cost 6.7x and output 12x.
    expect(resolveDeprecatedModelId('grok-3-mini')).toBe('grok-3-mini');
  });
});

/**
 * Drift guards. The bug these prevent: `grok-3` sat in the picker for ten months after
 * Grok 4.5 shipped, with no mapping, so every session pinned to it silently kept running a
 * non-reasoning, non-vision model at 1.5x the price of the current one. Hiding a model from
 * the picker is not enough -- a session's `lastUsedModel` still reaches it.
 */
describe('DEPRECATED_MODEL_MAP invariants (xAI catalog)', () => {
  // getModelInfo() returns a static array, so this key is never used for a network call.
  it('maps every deprecated xAI model so pinned sessions cannot be stranded', async () => {
    const models = await new XAIBackend('test-key-not-used').getModelInfo();
    const unmapped = models.filter(m => m.deprecationDate && !DEPRECATED_MODEL_MAP[m.id]).map(m => m.id);

    expect(
      unmapped,
      `xAI models carrying a deprecationDate with no DEPRECATED_MODEL_MAP entry: ${unmapped.join(', ')}`
    ).toEqual([]);
  });

  it('never maps a deprecated model to another deprecated model', async () => {
    const models = await new XAIBackend('test-key-not-used').getModelInfo();
    const deprecated = new Set(models.filter(m => m.deprecationDate).map(m => m.id));
    const xaiIds = new Set(models.map(m => m.id));

    // Only check targets we can see in this catalog; cross-backend targets are out of scope.
    const badTargets = Object.entries(DEPRECATED_MODEL_MAP)
      .filter(([, target]) => xaiIds.has(target) && deprecated.has(target))
      .map(([from, target]) => `${from} -> ${target}`);

    expect(badTargets, `mappings pointing at a deprecated model: ${badTargets.join(', ')}`).toEqual([]);
  });

  it('maps only to models that exist in the catalog', async () => {
    const models = await new XAIBackend('test-key-not-used').getModelInfo();
    const xaiIds = new Set(models.map(m => m.id));

    // Scoped to xAI sources so Anthropic/OpenAI targets are not flagged as missing.
    const dangling = Object.entries(DEPRECATED_MODEL_MAP)
      .filter(([from]) => from.startsWith('grok-'))
      .filter(([, target]) => !xaiIds.has(target))
      .map(([from, target]) => `${from} -> ${target}`);

    expect(dangling, `xAI mappings whose target is not in the catalog: ${dangling.join(', ')}`).toEqual([]);
  });
});
