import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  buildChain,
  foldEvents,
  sealEvent,
  verifyChain,
  type MemoryEvent,
  type MemoryEventInput,
} from './ledger';
import type { Principal } from './types';

const user: Principal = { kind: 'user', id: 'u1' };

const ev = (over: Partial<MemoryEventInput>): MemoryEventInput => ({
  principal: user,
  kind: 'assert',
  subject: 's',
  at: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('ledger chain', () => {
  it('is deterministic: same inputs produce a byte-identical chain', () => {
    const inputs = [
      ev({ subject: 'a', fact: 'A', at: '2026-07-01T00:00:00.000Z' }),
      ev({ subject: 'b', fact: 'B', at: '2026-07-02T00:00:00.000Z' }),
    ];
    expect(buildChain(inputs)).toEqual(buildChain(inputs));
  });

  it('chains each event to its predecessor; genesis has a null prevHash', () => {
    const chain = buildChain([ev({ subject: 'a' }), ev({ subject: 'b' })]);
    expect(chain[0].prevHash).toBeNull();
    expect(chain[1].prevHash).toBe(chain[0].hash);
  });

  it('does not depend on the order of the sources array', () => {
    const a = appendEvent([], ev({ sources: ['x', 'y', 'z'] }));
    const b = appendEvent([], ev({ sources: ['z', 'x', 'y'] }));
    expect(a.hash).toBe(b.hash);
  });

  it('sealEvent chains onto a given head hash identically to appendEvent', () => {
    const genesis = appendEvent([], ev({ subject: 'a' }));
    const next = ev({ subject: 'b', at: '2026-07-02T00:00:00.000Z' });
    expect(sealEvent(genesis.hash, next)).toEqual(appendEvent([genesis], next));
    expect(sealEvent(null, next)).toEqual(appendEvent([], next));
  });

  it('verifies an intact chain', () => {
    const chain = buildChain([ev({ subject: 'a' }), ev({ subject: 'b' }), ev({ subject: 'c' })]);
    expect(verifyChain(chain)).toEqual({ ok: true, brokenAt: -1 });
  });

  it('detects a mutated field (content hash no longer matches)', () => {
    const chain = buildChain([ev({ subject: 'a', fact: 'A' }), ev({ subject: 'b', fact: 'B' })]);
    const tampered: MemoryEvent[] = [...chain];
    tampered[1] = { ...tampered[1], fact: 'B-altered' };
    expect(verifyChain(tampered)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('detects a deleted event (broken link)', () => {
    const chain = buildChain([ev({ subject: 'a' }), ev({ subject: 'b' }), ev({ subject: 'c' })]);
    const withHole = [chain[0], chain[2]]; // drop the middle event
    expect(verifyChain(withHole)).toEqual({ ok: false, brokenAt: 1 });
  });
});

describe('deterministic fold', () => {
  it('assert creates a belief carrying its evidence tier and source event hash', () => {
    const chain = buildChain([
      ev({ subject: 'role', fact: 'User runs discovery calls', evidenceTier: 'external-facing' }),
    ]);
    const [belief] = foldEvents(chain);
    expect(belief.fact).toBe('User runs discovery calls');
    expect(belief.evidenceTier).toBe('external-facing');
    expect(belief.confidence).toBeCloseTo(0.8);
    expect(belief.derivedFrom).toEqual([chain[0].hash]);
  });

  it('affirm refreshes recency, accrues provenance, and can raise (never lower) the tier', () => {
    const chain = buildChain([
      ev({ subject: 'role', fact: 'role', evidenceTier: 'engineering-proxy', at: '2026-07-01T00:00:00.000Z' }),
      ev({ subject: 'role', kind: 'affirm', evidenceTier: 'human-reviewed', at: '2026-07-05T00:00:00.000Z' }),
      ev({ subject: 'role', kind: 'affirm', evidenceTier: 'engineering-proxy', at: '2026-07-06T00:00:00.000Z' }),
    ]);
    const [belief] = foldEvents(chain);
    expect(belief.lastAffirmedAt).toBe('2026-07-06T00:00:00.000Z');
    expect(belief.evidenceTier).toBe('human-reviewed'); // raised by event 2, not lowered by event 3
    expect(belief.derivedFrom).toHaveLength(3);
  });

  it('retract folds the belief away', () => {
    const chain = buildChain([
      ev({ subject: 'role', fact: 'role' }),
      ev({ subject: 'role', kind: 'retract', at: '2026-07-02T00:00:00.000Z' }),
    ]);
    expect(foldEvents(chain)).toEqual([]);
  });

  it('affirming a never-asserted (or retracted) subject is a no-op', () => {
    const chain = buildChain([ev({ subject: 'ghost', kind: 'affirm' })]);
    expect(foldEvents(chain)).toEqual([]);
  });

  it('re-asserting after a retract brings the belief back with fresh provenance', () => {
    const chain = buildChain([
      ev({ subject: 'role', fact: 'v1', at: '2026-07-01T00:00:00.000Z' }),
      ev({ subject: 'role', kind: 'retract', at: '2026-07-02T00:00:00.000Z' }),
      ev({ subject: 'role', fact: 'v2', at: '2026-07-03T00:00:00.000Z' }),
    ]);
    const [belief] = foldEvents(chain);
    expect(belief.fact).toBe('v2');
    expect(belief.derivedFrom).toEqual([chain[2].hash]);
  });

  it('orders beliefs most-recently-affirmed first', () => {
    const chain = buildChain([
      ev({ subject: 'old', fact: 'old', at: '2026-07-01T00:00:00.000Z' }),
      ev({ subject: 'new', fact: 'new', at: '2026-07-09T00:00:00.000Z' }),
    ]);
    expect(foldEvents(chain).map(b => b.id)).toEqual(['new', 'old']);
  });

  it('is replayable: folding the same ledger twice yields identical beliefs', () => {
    const chain = buildChain([
      ev({ subject: 'a', fact: 'A', at: '2026-07-01T00:00:00.000Z' }),
      ev({ subject: 'b', fact: 'B', at: '2026-07-02T00:00:00.000Z' }),
      ev({ subject: 'a', kind: 'affirm', at: '2026-07-03T00:00:00.000Z' }),
    ]);
    expect(foldEvents(chain)).toEqual(foldEvents(chain));
  });
});

describe('computed salience (ACT-R activation)', () => {
  it('computes activation and a thresholded salience for every belief', () => {
    const chain = buildChain([ev({ subject: 'a', fact: 'A', at: '2026-07-10T00:00:00.000Z' })]);
    const [belief] = foldEvents(chain, { now: '2026-07-11T00:00:00.000Z' });
    expect(typeof belief.activation).toBe('number');
    expect(['hot', 'warm', 'cold']).toContain(belief.salience);
  });

  it('a recently-affirmed belief is hotter than a stale one', () => {
    const chain = buildChain([
      ev({ subject: 'stale', fact: 'stale', at: '2026-06-01T00:00:00.000Z' }),
      ev({ subject: 'fresh', fact: 'fresh', at: '2026-06-01T00:00:00.000Z' }),
      ev({ subject: 'fresh', kind: 'affirm', at: '2026-07-10T00:00:00.000Z' }),
    ]);
    const beliefs = foldEvents(chain, { now: '2026-07-11T00:00:00.000Z' });
    const fresh = beliefs.find(b => b.id === 'fresh')!;
    const stale = beliefs.find(b => b.id === 'stale')!;
    expect(fresh.activation!).toBeGreaterThan(stale.activation!);
    expect(fresh.salience).toBe('hot');
    expect(stale.salience).toBe('cold');
  });

  it('decays as of a later read time: the same ledger goes colder when now advances', () => {
    const chain = buildChain([ev({ subject: 'a', fact: 'A', at: '2026-07-10T00:00:00.000Z' })]);
    const soon = foldEvents(chain, { now: '2026-07-11T00:00:00.000Z' })[0].activation!;
    const later = foldEvents(chain, { now: '2026-09-01T00:00:00.000Z' })[0].activation!;
    expect(later).toBeLessThan(soon);
  });

  it('orders beliefs most-active first', () => {
    const chain = buildChain([
      ev({ subject: 'cold', fact: 'cold', at: '2026-05-01T00:00:00.000Z' }),
      ev({ subject: 'hot', fact: 'hot', at: '2026-07-10T00:00:00.000Z' }),
    ]);
    expect(foldEvents(chain, { now: '2026-07-11T00:00:00.000Z' }).map(b => b.id)).toEqual(['hot', 'cold']);
  });
});
