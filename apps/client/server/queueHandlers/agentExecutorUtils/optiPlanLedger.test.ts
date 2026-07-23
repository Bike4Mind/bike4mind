import { describe, it, expect } from 'vitest';
import { rehydrateOptiPlanState, optiPlanActive } from './optiPlanLedger';

describe('rehydrateOptiPlanState', () => {
  it('returns a fresh empty ledger when nothing is persisted', () => {
    expect(rehydrateOptiPlanState(undefined)).toEqual({ decomposeUsed: false, steps: [], solved: {}, results: {} });
    expect(rehydrateOptiPlanState(null)).toEqual({ decomposeUsed: false, steps: [], solved: {}, results: {} });
  });

  it('rehydrates the persisted ledger for a continuation', () => {
    const persisted = {
      decomposeUsed: true,
      steps: [{ family: 'scheduling', title: 'Seq' }],
      solved: { scheduling: 1 },
      results: { scheduling: 'SA (makespan: 130)' },
    };
    expect(rehydrateOptiPlanState(persisted)).toEqual(persisted);
  });

  it('deep-copies so guard mutations do not alias the persisted doc', () => {
    const persisted = {
      decomposeUsed: true,
      steps: [{ family: 'scheduling', title: 'Seq' }],
      solved: { scheduling: 1 },
      results: {},
    };
    const state = rehydrateOptiPlanState(persisted);
    state.solved.scheduling = 99;
    state.steps.push({ family: 'routing', title: 'Route' });
    expect(persisted.solved.scheduling).toBe(1); // original untouched
    expect(persisted.steps).toHaveLength(1);
  });
});

describe('optiPlanActive', () => {
  it('is false for a fresh ledger, true once decompose ran or a plan loaded', () => {
    expect(optiPlanActive({ decomposeUsed: false, steps: [] })).toBe(false);
    expect(optiPlanActive({ decomposeUsed: true, steps: [] })).toBe(true);
    expect(optiPlanActive({ decomposeUsed: false, steps: [{ family: 'x', title: 'y' }] })).toBe(true);
  });
});
