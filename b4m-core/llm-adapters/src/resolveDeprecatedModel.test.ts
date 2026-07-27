import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  catalogSuccessors,
  resetReplacedByOverlay,
  resolveDeprecatedModelId,
  updateReplacedByOverlay,
} from './resolveDeprecatedModel';

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
