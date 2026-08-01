import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import {
  DEPRECATED_MODEL_MAP,
  buildSupersededIndex,
  catalogSuccessors,
  resetReplacedByOverlay,
  resolveDeprecatedModelId,
  updateReplacedByOverlay,
} from './resolveDeprecatedModel';
import { XAIBackend } from './xaiBackend';

describe('resolveDeprecatedModelId', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetReplacedByOverlay();
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

describe('resolveDeprecatedModelId with the catalog overlay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetReplacedByOverlay();
    vi.restoreAllMocks();
  });

  it('lets a catalog successor beat the static map for the same id', () => {
    updateReplacedByOverlay({ 'claude-3-5-sonnet-20241022': 'claude-sonnet-5' });
    expect(resolveDeprecatedModelId('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-5');
  });

  it('accepts either a Map or a plain record, replacing the previous overlay wholesale', () => {
    updateReplacedByOverlay(new Map([['a', 'b']]));
    expect(resolveDeprecatedModelId('a')).toBe('b');

    updateReplacedByOverlay({ c: 'd' });
    // 'a' is gone from the overlay, so it falls through to the static map (a miss).
    expect(resolveDeprecatedModelId('a')).toBe('a');
    expect(resolveDeprecatedModelId('c')).toBe('d');
  });

  it('follows a chain across both tables and warns once, naming the endpoints', () => {
    // b is a static-map entry, so the chain crosses tables mid-walk.
    updateReplacedByOverlay({ a: 'claude-3-5-sonnet-20241022' });
    expect(resolveDeprecatedModelId('a', 'chain-test')).toBe('claude-sonnet-4-6');

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('a -> claude-sonnet-4-6'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('chain-test'));
  });

  it('terminates on a cycle, returning the last new id rather than looping', () => {
    updateReplacedByOverlay({ a: 'b', b: 'a' });
    expect(resolveDeprecatedModelId('a')).toBe('b');
    expect(resolveDeprecatedModelId('b')).toBe('a');
  });

  it('stops at the hop cap on a runaway chain', () => {
    updateReplacedByOverlay({ a: 'b', b: 'c', c: 'd', d: 'e', e: 'f', f: 'g', g: 'h' });
    // Five hops from a: b, c, d, e, f.
    expect(resolveDeprecatedModelId('a')).toBe('f');
  });

  it('keeps the previous overlay when the caller never refreshes it (catalog fetch failure)', () => {
    updateReplacedByOverlay({ a: 'b' });
    // A failing catalog read never calls the updater at all.
    expect(resolveDeprecatedModelId('a')).toBe('b');
  });
});

describe('buildSupersededIndex', () => {
  const model = (id: string, name: string) => ({ id, name }) as ModelInfo;

  afterEach(() => resetReplacedByOverlay());

  it('names a pin the deprecation filter already hid, from the pre-filter list', () => {
    const allModels = [model('grok-3', 'Grok 3'), model('grok-4.5', 'Grok 4.5')];
    const currentModels = [model('grok-4.5', 'Grok 4.5')];

    expect(buildSupersededIndex(allModels, currentModels)).toContainEqual({
      id: 'grok-3',
      name: 'Grok 3',
      replacementId: 'grok-4.5',
      replacementName: 'Grok 4.5',
    });
  });

  it('falls back to the raw id when this deployment never listed the model', () => {
    const currentModels = [model('grok-4.5', 'Grok 4.5')];

    expect(buildSupersededIndex([], currentModels)).toContainEqual({
      id: 'grok-3',
      name: 'grok-3',
      replacementId: 'grok-4.5',
      replacementName: 'Grok 4.5',
    });
  });

  it('drops mappings whose replacement this deployment cannot run, so no prompt is dead', () => {
    // No xAI credentials: grok-4.5 is absent, so every grok mapping must drop out.
    const index = buildSupersededIndex([], [model('claude-sonnet-4-6', 'Claude Sonnet 4.6')]);

    expect(index.some(e => e.replacementId === 'grok-4.5')).toBe(false);
    expect(index.map(e => e.id)).toContain('claude-3-5-sonnet-20241022');
  });

  it('offers the catalog successor over the static map, matching what a pinned request resolves to', () => {
    updateReplacedByOverlay({ 'claude-3-5-sonnet-20241022': 'claude-sonnet-5' });
    const current = [model('claude-sonnet-5', 'Claude Sonnet 5'), model('claude-sonnet-4-6', 'Claude Sonnet 4.6')];

    const entry = buildSupersededIndex([], current).find(e => e.id === 'claude-3-5-sonnet-20241022');
    expect(entry).toMatchObject({ replacementId: 'claude-sonnet-5', replacementName: 'Claude Sonnet 5' });
  });

  it('includes catalog-only ids that the static map has never heard of', () => {
    updateReplacedByOverlay({ 'some-catalog-model': 'grok-4.5' });

    const index = buildSupersededIndex(
      [model('some-catalog-model', 'Some Catalog Model')],
      [model('grok-4.5', 'Grok 4.5')]
    );
    expect(index).toContainEqual({
      id: 'some-catalog-model',
      name: 'Some Catalog Model',
      replacementId: 'grok-4.5',
      replacementName: 'Grok 4.5',
    });
  });

  it('follows a multi-hop chain to the id the resolver would land on', () => {
    updateReplacedByOverlay({ a: 'b', b: 'grok-4.5' });

    const entry = buildSupersededIndex([], [model('grok-4.5', 'Grok 4.5')]).find(e => e.id === 'a');
    expect(entry?.replacementId).toBe('grok-4.5');
  });

  it('emits no [model-sunset] warnings: an index build is not traffic being redirected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildSupersededIndex([], [model('grok-4.5', 'Grok 4.5')]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('catalogSuccessors', () => {
  it('takes replacedBy only from sunset models: an active plan is not a redirect', () => {
    const successors = catalogSuccessors(
      new Map([
        ['dep', { status: 'deprecated', replacedBy: 'next' }],
        ['ret', { status: 'retired', replacedBy: 'next' }],
        ['live', { status: 'active', replacedBy: 'next' }],
        ['silent', { status: 'deprecated' }],
      ])
    );

    expect([...successors]).toEqual([
      ['dep', 'next'],
      ['ret', 'next'],
    ]);
  });
});
