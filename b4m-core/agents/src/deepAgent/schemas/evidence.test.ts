import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_TIER_ORDER,
  EvidenceTierSchema,
  evidenceTierAtLeast,
  evidenceTierRank,
  type EvidenceTier,
} from './evidence';

describe('EvidenceTierSchema', () => {
  it('accepts every canonical tier', () => {
    for (const tier of EVIDENCE_TIER_ORDER) {
      expect(EvidenceTierSchema.safeParse(tier).success).toBe(true);
    }
  });

  it('rejects an unknown tier', () => {
    expect(EvidenceTierSchema.safeParse('engineering-vibes').success).toBe(false);
  });
});

describe('evidence tier ordering', () => {
  it('is the total order proxy < scaled < external-facing < human-reviewed', () => {
    expect(EVIDENCE_TIER_ORDER).toEqual([
      'engineering-proxy',
      'engineering-scaled',
      'external-facing',
      'human-reviewed',
    ]);
  });

  it('ranks each tier by its position in the order', () => {
    EVIDENCE_TIER_ORDER.forEach((tier, idx) => {
      expect(evidenceTierRank(tier)).toBe(idx);
    });
  });

  it('rank is strictly monotonic across the order', () => {
    const ranks = EVIDENCE_TIER_ORDER.map(evidenceTierRank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });
});

describe('evidenceTierAtLeast', () => {
  it('is true when a tier meets its own bar (reflexive)', () => {
    for (const tier of EVIDENCE_TIER_ORDER) {
      expect(evidenceTierAtLeast(tier, tier)).toBe(true);
    }
  });

  it('is true when actual exceeds required', () => {
    expect(evidenceTierAtLeast('human-reviewed', 'engineering-proxy')).toBe(true);
    expect(evidenceTierAtLeast('external-facing', 'engineering-scaled')).toBe(true);
  });

  it('is false when actual falls short of required', () => {
    expect(evidenceTierAtLeast('engineering-proxy', 'external-facing')).toBe(false);
    expect(evidenceTierAtLeast('engineering-scaled', 'human-reviewed')).toBe(false);
  });

  it('gates exploration cost: proxy work never satisfies an external-facing bar', () => {
    const required: EvidenceTier = 'external-facing';
    expect(evidenceTierAtLeast('engineering-proxy', required)).toBe(false);
    expect(evidenceTierAtLeast('engineering-scaled', required)).toBe(false);
    expect(evidenceTierAtLeast('external-facing', required)).toBe(true);
    expect(evidenceTierAtLeast('human-reviewed', required)).toBe(true);
  });
});
