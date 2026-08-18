import { describe, it, expect } from 'vitest';
import { rehydrateOptiPlanState, optiPlanActive, ledgerForWrite } from './optiPlanLedger';

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

  it('deep-copies so guard mutations do not alias the persisted doc (steps + solved + results)', () => {
    const persisted = {
      decomposeUsed: true,
      steps: [{ family: 'scheduling', title: 'Seq' }],
      solved: { scheduling: 1 },
      results: { scheduling: 'SA' },
    };
    const state = rehydrateOptiPlanState(persisted);
    state.solved.scheduling = 99;
    state.results.scheduling = 'changed';
    state.steps.push({ family: 'routing', title: 'Route' });
    state.steps[0].title = 'mutated';
    expect(persisted.solved.scheduling).toBe(1); // original solved untouched
    expect(persisted.results.scheduling).toBe('SA'); // original results untouched
    expect(persisted.steps).toHaveLength(1);
    expect(persisted.steps[0].title).toBe('Seq'); // per-step object copied, not aliased
  });

  it('tolerates a partial persisted ledger (minimize drops empty solved/results on read)', () => {
    // What Mongo actually returns when solved/results were {} at write time (schema minimize).
    const partial = { decomposeUsed: true, steps: [{ family: 'scheduling', title: 'Seq' }] } as never;
    expect(rehydrateOptiPlanState(partial)).toEqual({
      decomposeUsed: true,
      steps: [{ family: 'scheduling', title: 'Seq' }],
      solved: {},
      results: {},
    });
  });
});

describe('optiPlanActive', () => {
  it('is false for a fresh ledger, true once decompose ran or a plan loaded', () => {
    expect(optiPlanActive({ decomposeUsed: false, steps: [] })).toBe(false);
    expect(optiPlanActive({ decomposeUsed: true, steps: [] })).toBe(true);
    expect(optiPlanActive({ decomposeUsed: false, steps: [{ family: 'x', title: 'y' }] })).toBe(true);
  });
});

describe('ledgerForWrite', () => {
  it('returns the ledger when active, undefined when there is nothing to persist', () => {
    const active = { decomposeUsed: true, steps: [], solved: {}, results: {} };
    expect(ledgerForWrite(active)).toBe(active);
    expect(ledgerForWrite({ decomposeUsed: false, steps: [], solved: {}, results: {} })).toBeUndefined();
  });
});
