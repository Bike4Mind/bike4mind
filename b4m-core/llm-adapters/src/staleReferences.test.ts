import { afterEach, describe, expect, it } from 'vitest';
import { checkStaleModelReferences, type StaleModelReference } from './staleReferences';
import { resetReplacedByOverlay, updateReplacedByOverlay } from './resolveDeprecatedModel';

const NOW = new Date('2026-07-26T00:00:00Z');

// A live model, one past its deprecation date, and one the catalog retired.
const MODELS = [{ id: 'live-1' }, { id: 'live-2' }, { id: 'sunset-1', deprecationDate: '2026-01-01' }];

const LIFECYCLES = new Map([
  ['live-1', { status: 'active' }],
  ['sunset-1', { status: 'deprecated', deprecationDate: '2026-01-01' }],
  ['gone-1', { status: 'retired', retirementDate: '2025-12-01' }],
  // Metadata-only: the merge never promotes it, so it is absent from MODELS.
  ['found-1', { status: 'discovered' }],
]);

const run = (input: Partial<Parameters<typeof checkStaleModelReferences>[0]> = {}): StaleModelReference[] =>
  checkStaleModelReferences({ models: MODELS, lifecycles: LIFECYCLES, now: NOW, ...input });

const forSurface = (found: StaleModelReference[], surface: string) => found.filter(f => f.surface === surface);

afterEach(() => resetReplacedByOverlay());

describe('checkStaleModelReferences', () => {
  it('reports nothing when every referenced id is live', () => {
    const found = run({ fallbackChains: { 'live-1': ['live-2'] }, defaultChain: ['live-2'] });
    expect(forSurface(found, 'fallback-chain')).toEqual([]);
    expect(forSurface(found, 'fallback-default')).toEqual([]);
  });

  it('flags a chain entry that is deprecated, retired, or absent entirely', () => {
    const found = forSurface(
      run({ fallbackChains: { 'live-1': ['sunset-1', 'gone-1', 'never-existed'] } }),
      'fallback-chain'
    );

    expect(found).toEqual([
      { surface: 'fallback-chain', key: 'live-1', referencedId: 'gone-1', problem: 'retired' },
      { surface: 'fallback-chain', key: 'live-1', referencedId: 'never-existed', problem: 'unknown' },
      { surface: 'fallback-chain', key: 'live-1', referencedId: 'sunset-1', problem: 'deprecated' },
    ]);
  });

  it('separates a chain keyed on a dead model from one pointing at it', () => {
    const found = run({ fallbackChains: { 'sunset-1': ['live-1'] } });
    expect(forSurface(found, 'fallback-chain')).toEqual([]);
    expect(forSurface(found, 'fallback-chain-key')).toEqual([
      { surface: 'fallback-chain-key', key: 'sunset-1', referencedId: 'sunset-1', problem: 'deprecated' },
    ]);
  });

  it('flags the generic default chain under its own surface', () => {
    const found = forSurface(run({ defaultChain: ['live-1', 'gone-1'] }), 'fallback-default');
    expect(found).toEqual([
      { surface: 'fallback-default', key: 'default', referencedId: 'gone-1', problem: 'retired' },
    ]);
  });

  it('audits the static sunset map targets, not its keys (those are dead by definition)', () => {
    const found = forSurface(run(), 'deprecated-model-map');
    // Nothing in the fixture model set is a static-map target, so every target
    // reads as unknown - and no entry is ever reported under its source id.
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(entry.problem).toBe('unknown');
      expect(entry.referencedId).not.toBe(entry.key);
    }
  });

  it('audits the catalog replacedBy overlay targets', () => {
    updateReplacedByOverlay({ 'sunset-1': 'gone-1', other: 'live-1' });
    expect(forSurface(run(), 'replaced-by-overlay')).toEqual([
      { surface: 'replaced-by-overlay', key: 'sunset-1', referencedId: 'gone-1', problem: 'retired' },
    ]);
  });

  it('treats a deprecation date as inclusive, matching the picker filter', () => {
    const found = run({
      models: [{ id: 'today', deprecationDate: '2026-07-26' }],
      lifecycles: new Map(),
      fallbackChains: { k: ['today'] },
    });
    expect(forSurface(found, 'fallback-chain')[0]).toMatchObject({ referencedId: 'today', problem: 'deprecated' });
  });

  it('classifies a model the picker already dropped from the catalog, not as unknown', () => {
    // gone-1 is absent from `models` (filtered out) but present in the catalog.
    const found = run({ fallbackChains: { 'live-1': ['gone-1'] } });
    expect(forSurface(found, 'fallback-chain')[0].problem).toBe('retired');
  });

  it('flags a target the catalog knows but the merged list does not carry', () => {
    // A 'discovered' model is metadata-only, so a chain pointing at it is an
    // unreachable fallback - not the healthy reference it used to read as.
    const found = run({ fallbackChains: { 'live-1': ['found-1'] }, defaultChain: ['found-1'] });
    expect(forSurface(found, 'fallback-chain')).toEqual([
      { surface: 'fallback-chain', key: 'live-1', referencedId: 'found-1', problem: 'not-invocable' },
    ]);
    expect(forSurface(found, 'fallback-default')[0].problem).toBe('not-invocable');
  });

  it('never rewrites its input: the report is the whole output', () => {
    const chains = { 'live-1': ['sunset-1'] };
    run({ fallbackChains: chains });
    expect(chains).toEqual({ 'live-1': ['sunset-1'] });
  });
});
