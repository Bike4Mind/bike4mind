import { describe, it, expect } from 'vitest';
import { deriveLakeHealthBadge } from './LakeHealthBadge';

const predicates = (over?: Partial<Record<string, unknown>>) => ({
  chunkWithinPolicy: { pass: 1, fail: 0, unknown: 0 },
  chunkCountConsistent: { pass: 1, fail: 0, unknown: 0 },
  fullyVectorized: { pass: 1, fail: 0, unknown: 0 },
  serveCapMeetsPolicy: 'pass' as const,
  ...over,
});

describe('deriveLakeHealthBadge', () => {
  it('is unknown when nothing is measured (share null), never a false low score', () => {
    expect(deriveLakeHealthBadge({ reachableShare: null, predicates: predicates() })).toBe('unknown');
  });

  it('is healthy only when reachability is high AND no predicate fails', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 1, predicates: predicates() })).toBe('healthy');
    expect(deriveLakeHealthBadge({ reachableShare: 0.97, predicates: predicates() })).toBe('healthy');
  });

  it('is degraded on a predicate failure even at high reachability', () => {
    expect(
      deriveLakeHealthBadge({
        reachableShare: 0.99,
        predicates: predicates({ fullyVectorized: { pass: 4, fail: 1, unknown: 0 } }),
      })
    ).toBe('degraded');
  });

  it('is degraded in the middle reachability band', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 0.8, predicates: predicates() })).toBe('degraded');
  });

  it('is unhealthy below half reachable', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 0.245, predicates: predicates() })).toBe('unhealthy');
  });

  it('treats a serve-cap-below-policy (P4) defect as unhealthy regardless of reachability', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 1, predicates: predicates({ serveCapMeetsPolicy: 'fail' }) })).toBe(
      'unhealthy'
    );
  });
});
