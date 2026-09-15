import type { ILatticeDataStore, ILatticeEntity, ILatticeRule, ILatticeRulesStore } from '@bike4mind/common';
import { afterEach, describe, expect, it } from 'vitest';
import { HydrationEngine } from './HydrationEngine';

const now = new Date();

const entity = (id: string, attrs: { key: string; value: number }[] = []): ILatticeEntity => ({
  id,
  type: 'line_item',
  name: id,
  attributes: attrs.map(a => ({ key: a.key, value: a.value, dataType: 'number', isComputed: false })),
  metadata: {},
  createdAt: now,
  updatedAt: now,
});

const addRule = (id: string, targetEntityId: string, targetAttribute: string): ILatticeRule => ({
  id,
  name: id,
  type: 'formula',
  definition: {
    operation: 'ADD',
    inputs: [
      { type: 'literal', ref: '1' },
      { type: 'literal', ref: '2' },
    ],
    output: { targetEntityId, targetAttribute, dataType: 'number' },
  },
  dependencies: [],
  priority: 0,
  enabled: true,
  createdAt: now,
  updatedAt: now,
});

const store = (rules: ILatticeRule[]): ILatticeRulesStore => ({ rules, rulesets: [] });
const data = (entities: ILatticeEntity[]): ILatticeDataStore => ({ entities, relationships: [] });

describe('HydrationEngine prototype-pollution guards', () => {
  afterEach(() => {
    // Fail loudly if any case leaked onto the shared prototype.
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('computes a safe-target rule (control) but rejects one targeting a reserved entity name', () => {
    const engine = new HydrationEngine();

    // Control: the identical rule with a safe target must succeed, so the rejection below
    // is provably caused by the guard and not a broken fixture.
    const ok = engine.hydrate(data([entity('revenue')]), store([addRule('r1', 'revenue', 'total')]));
    expect(ok.errors).toHaveLength(0);
    expect(ok.values.revenue.total.value).toBe(3);

    const result = engine.hydrate(data([entity('revenue')]), store([addRule('r1', '__proto__', 'polluted')]));
    expect(result.errors.some(e => /r1/.test(JSON.stringify(e)))).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result.values, '__proto__')).toBe(false);
  });

  it('rejects a rule whose output targets a reserved attribute name', () => {
    const engine = new HydrationEngine();
    const result = engine.hydrate(data([entity('revenue')]), store([addRule('r1', 'revenue', 'constructor')]));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(result.values.revenue, 'constructor')).toBe(false);
  });

  it('stores a base-data entity named __proto__ as a harmless own key, not on the prototype', () => {
    const engine = new HydrationEngine();
    const result = engine.hydrate(data([entity('__proto__', [{ key: 'x', value: 5 }])]), store([]));

    // Handled as a literal key: it appears in the computed values, prototype untouched.
    expect(Object.prototype.hasOwnProperty.call(result.values, '__proto__')).toBe(true);
  });
});

describe('HydrationEngine matchesPattern (regex-injection guard)', () => {
  // matchesPattern is private; exercise it directly - it is the pattern-compilation sink.
  const match = (pattern: string, entityId: string): boolean =>
    (new HydrationEngine() as unknown as { matchesPattern(e: string, p: string): boolean }).matchesPattern(
      entityId,
      pattern
    );

  it('keeps the * wildcard working', () => {
    expect(match('rev*', 'revenue')).toBe(true);
    expect(match('*enue', 'revenue')).toBe(true);
    expect(match('*', 'anything')).toBe(true);
  });

  it('treats other regex metacharacters as literals, not operators', () => {
    // '.' must be a literal dot, not "any char"
    expect(match('a.b', 'axb')).toBe(false);
    expect(match('a.b', 'a.b')).toBe(true);
  });

  it('keeps a metacharacter literal on the wildcard path, where the injection actually lived', () => {
    // The `a.b` case above returns on `!pattern.includes('*')` before the matcher is entered, so
    // it never pinned this. Combining `*` with another metacharacter is the only shape that does.
    // Under the pre-fix `pattern.replace(/\*/g, '.*')` compile these both invert: `^.*[ab]$`
    // matched 'xa' and rejected 'x[ab]'. (A revert to the round-1 escape-then-compile form is
    // indistinguishable here by construction - the chained-* timing case below is what pins that.)
    expect(match('*[ab]', 'xa')).toBe(false);
    expect(match('*[ab]', 'x[ab]')).toBe(true);
  });

  it('matches multi-* globs correctly', () => {
    expect(match('*a*b', 'xxaybzzb')).toBe(true);
    expect(match('*a*b', 'xxbyyaz')).toBe(false);
    expect(match('a*b*', 'ab')).toBe(true);
    expect(match('a**b', 'axxb')).toBe(true);
    expect(match('rev*', 'rev')).toBe(true);
    expect(match('*enue', 'enue')).toBe(true);
  });

  it('stays linear on a chained-* pattern that made the compiled form exponential', () => {
    // Every case above lacks a `*` chain, so it is this one that exercises the matcher's
    // hot path. Under the previous escape-then-compile form this pattern became
    // `.*a.*a...Z` and blocked the event loop for ~30s against the same subject; the
    // two-pointer matcher returns in well under a millisecond. The bound is loose on
    // purpose - it only needs to separate "linear" from "exponential", not to be a
    // benchmark, so CPU contention in CI cannot flake it.
    const pattern = '*a'.repeat(12) + 'Z';
    const t0 = performance.now();
    expect(match(pattern, 'a'.repeat(40))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
