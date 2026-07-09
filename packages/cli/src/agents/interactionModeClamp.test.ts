import { describe, it, expect } from 'vitest';
import type { InteractionMode } from '../bootstrap/types.js';
import { INTERACTION_MODE_RANK, clampInteractionMode } from './interactionModeClamp.js';

const MODES: InteractionMode[] = ['plan', 'normal', 'auto-accept'];

describe('INTERACTION_MODE_RANK', () => {
  it('orders modes plan < normal < auto-accept by permissiveness', () => {
    expect(INTERACTION_MODE_RANK.plan).toBeLessThan(INTERACTION_MODE_RANK.normal);
    expect(INTERACTION_MODE_RANK.normal).toBeLessThan(INTERACTION_MODE_RANK['auto-accept']);
  });
});

describe('clampInteractionMode', () => {
  it('never returns a mode more permissive than the ceiling (all pairs)', () => {
    for (const requested of MODES) {
      for (const ceiling of MODES) {
        const result = clampInteractionMode(requested, ceiling);
        expect(INTERACTION_MODE_RANK[result]).toBeLessThanOrEqual(INTERACTION_MODE_RANK[ceiling]);
        expect(INTERACTION_MODE_RANK[result]).toBeLessThanOrEqual(INTERACTION_MODE_RANK[requested]);
      }
    }
  });

  it('caps a more permissive request to the ceiling', () => {
    expect(clampInteractionMode('auto-accept', 'normal')).toBe('normal');
    expect(clampInteractionMode('auto-accept', 'plan')).toBe('plan');
    expect(clampInteractionMode('normal', 'plan')).toBe('plan');
  });

  it('honors a request that is already at or below the ceiling', () => {
    expect(clampInteractionMode('normal', 'auto-accept')).toBe('normal');
    expect(clampInteractionMode('plan', 'normal')).toBe('plan');
    expect(clampInteractionMode('normal', 'normal')).toBe('normal');
  });

  it('a normal parent can never yield an auto-accept child', () => {
    expect(clampInteractionMode('auto-accept', 'normal')).not.toBe('auto-accept');
  });
});
