import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isModelDeprecated, type ModelInfo } from '@bike4mind/common';
import {
  DEPRECATED_MODEL_MAP,
  buildSupersededIndex,
  catalogSuccessors,
  resetReplacedByOverlay,
  resolveDeprecatedModelId,
  updateReplacedByOverlay,
} from './resolveDeprecatedModel';
import { AnthropicBackend } from './anthropicBackend';
import { AWSBackend } from './awsBackend';
import { UndifferentiatedBedrockBackend } from './bedrockBackend/undifferentiated';
import { BFLBackend } from './bflBackend';
import { DeepSeekBackend } from './deepseekBackend';
import { KimiBackend } from './kimiBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';
import { GeminiBackend } from './geminiBackend';
import { recordDeprecatedModelRequest } from './modelSunsetMetrics';

vi.mock('./modelSunsetMetrics', () => ({
  recordDeprecatedModelRequest: vi.fn().mockResolvedValue(undefined),
}));

describe('resolveDeprecatedModelId', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(recordDeprecatedModelRequest).mockClear();
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

  /**
   * This is the only place the metric can be emitted: getAvailableModels drops
   * every model at or past its deprecationDate, so anything downstream of it has
   * already lost the pinned id.
   */
  describe('staleness metric', () => {
    it('emits one datapoint per resolution, naming the pinned id and its successor', () => {
      resolveDeprecatedModelId('grok-3', 'test-context');

      expect(recordDeprecatedModelRequest).toHaveBeenCalledTimes(1);
      expect(recordDeprecatedModelRequest).toHaveBeenCalledWith('grok-3', 'grok-4.5');
    });

    it('emits the endpoints of a multi-hop chain, not each hop', () => {
      updateReplacedByOverlay({ 'model-a': 'model-b', 'model-b': 'model-c' });

      resolveDeprecatedModelId('model-a');

      expect(recordDeprecatedModelRequest).toHaveBeenCalledTimes(1);
      expect(recordDeprecatedModelRequest).toHaveBeenCalledWith('model-a', 'model-c');
    });

    it('does not emit for a current model', () => {
      resolveDeprecatedModelId('claude-sonnet-4-6');

      expect(recordDeprecatedModelRequest).not.toHaveBeenCalled();
    });
  });
});

/**
 * Drift guards. The bug these prevent: `grok-3` sat in the picker for ten months after
 * Grok 4.5 shipped, with no mapping, so every session pinned to it silently kept running a
 * non-reasoning, non-vision model at 1.5x the price of the current one. Hiding a model from
 * the picker is not enough -- a session's `lastUsedModel` still reaches it.
 *
 * Every backend with a static table, not just xAI: scoping the guard to one adapter is how
 * `kimi-k2.5` shipped hidden with no successor at all, which is worse than the grok-3 case.
 * That id 404s upstream, so the lookup in ChatCompletionProcess missed and the run died with
 * "Invalid LLM backend specified" before the fallback loop could rescue it.
 *
 * The static map is what this asserts on, not `lifecycle.replacedBy`: replacedBy reaches the
 * resolver through the catalog overlay, so it redirects nothing until the seed has been
 * loaded, while the map is the cold-start table that always holds.
 */
/**
 * Deprecated models that predate this guard, exempted so it can be turned on at all. Every
 * one of these is the same latent bug as kimi-k2.5 - a session pinned to it has no successor
 * to land on - and mapping one is a per-model pricing decision (see the "must not silently
 * raise a user's cost" rule in resolveDeprecatedModel), not a mechanical fix. Shrink this
 * list, never grow it: a NEW deprecated model has to carry a mapping, which is what the guard
 * below is for. The paired test fails on an entry that has stopped exempting anything.
 */
const UNMAPPED_LEGACY: ReadonlySet<string> = new Set<string>([
  'gpt-4',
  'gpt-4-turbo',
  'gpt-4.1-nano-2025-04-14',
  'gpt-4.5-preview-2025-02-27',
  'gpt-5.2-chat-latest',
  'o1-2024-12-17',
  'o1-mini-2024-09-12',
  'o1-preview-2024-09-12',
  'o3-2025-04-16',
  'o3-mini-2025-01-31',
  'o4-mini-2025-04-16',
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'sora-2',
  'sora-2-pro',
  'claude-3-5-haiku-20241022',
  'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-2.0-flash-exp',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-preview-09-25',
  'gemini-2.5-pro',
  'gemini-2.5-pro-preview-05-06',
  'gemini-3-pro-preview',
  'flux-pro',
]);

describe('DEPRECATED_MODEL_MAP invariants', () => {
  // Every getModelInfo() here returns a static array, so these keys never reach the network.
  // Ollama and LocalImage are absent because their listings are live server calls.
  const staticCatalog = async () => {
    const backends = [
      new OpenAIBackend('test-key-not-used'),
      new AnthropicBackend('test-key-not-used'),
      new UndifferentiatedBedrockBackend(),
      new GeminiBackend('test-key-not-used'),
      new XAIBackend('test-key-not-used'),
      new KimiBackend('test-key-not-used'),
      new DeepSeekBackend('test-key-not-used'),
      new AWSBackend(),
      new BFLBackend('test-key-not-used'),
    ];
    const models = (await Promise.all(backends.map(b => b.getModelInfo()))).flat();
    return {
      ids: new Set(models.map(m => String(m.id))),
      deprecated: new Set(models.filter(m => m.deprecationDate).map(m => String(m.id))),
    };
  };

  it('maps every deprecated model so pinned sessions cannot be stranded', async () => {
    const { deprecated } = await staticCatalog();
    const unmapped = [...deprecated].filter(id => !DEPRECATED_MODEL_MAP[id] && !UNMAPPED_LEGACY.has(id));

    expect(
      unmapped,
      `models carrying a deprecationDate with no DEPRECATED_MODEL_MAP entry: ${unmapped.join(', ')}`
    ).toEqual([]);
  });

  it('keeps the legacy exemption list honest', async () => {
    const { deprecated } = await staticCatalog();
    // An entry that has since been mapped, or whose model has left the tables,
    // is an exemption covering nothing - and a silent widening of the guard's
    // blind spot for whatever id is added next.
    const stale = [...UNMAPPED_LEGACY].filter(id => DEPRECATED_MODEL_MAP[id] || !deprecated.has(id));

    expect(stale, `UNMAPPED_LEGACY entries that no longer exempt anything: ${stale.join(', ')}`).toEqual([]);
  });

  it('never maps a deprecated model to another deprecated model', async () => {
    const { deprecated } = await staticCatalog();

    const badTargets = Object.entries(DEPRECATED_MODEL_MAP)
      .filter(([, target]) => deprecated.has(target))
      .map(([from, target]) => `${from} -> ${target}`);

    expect(badTargets, `mappings pointing at a deprecated model: ${badTargets.join(', ')}`).toEqual([]);
  });

  it('maps only to models that exist in the catalog', async () => {
    const { ids } = await staticCatalog();

    const dangling = Object.entries(DEPRECATED_MODEL_MAP)
      .filter(([, target]) => !ids.has(target))
      .map(([from, target]) => `${from} -> ${target}`);

    expect(dangling, `mappings whose target is not in any adapter table: ${dangling.join(', ')}`).toEqual([]);
  });
});

describe('Gemini 2.5 Flash retirement', () => {
  // getModelInfo() returns a static array, so this key is never used for a network call.
  const geminiModels = () => new GeminiBackend('test-key-not-used').getModelInfo();

  it('keeps gemini-2.5-flash out of the picker', async () => {
    const model = (await geminiModels()).find(m => m.id === 'gemini-2.5-flash');

    expect(model).toBeDefined();
    expect(isModelDeprecated(model as ModelInfo)).toBe(true);
  });

  it('resolves a pinned gemini-2.5-flash to a model the picker still offers', async () => {
    const resolved = resolveDeprecatedModelId('gemini-2.5-flash');
    const replacement = (await geminiModels()).find(m => m.id === resolved);

    expect(resolved).not.toBe('gemini-2.5-flash');
    expect(replacement).toBeDefined();
    expect(isModelDeprecated(replacement as ModelInfo)).toBe(false);
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
