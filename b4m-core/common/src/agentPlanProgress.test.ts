import { describe, it, expect } from 'vitest';
import { planStepProgress } from './agentPlanProgress';

describe('planStepProgress', () => {
  it('is null without a loaded plan', () => {
    expect(planStepProgress(null)).toBeNull();
    expect(planStepProgress(undefined)).toBeNull();
    expect(planStepProgress({ steps: [], solved: { scheduling: 2 } })).toBeNull();
  });

  it('counts solved steps against the plan length', () => {
    const steps = [{ family: 'scheduling' }, { family: 'routing' }, { family: 'routing' }];
    expect(planStepProgress({ steps })).toEqual({ completed: 0, total: 3 });
    expect(planStepProgress({ steps, solved: { routing: 1 } })).toEqual({ completed: 1, total: 3 });
    expect(planStepProgress({ steps, solved: { scheduling: 1, routing: 2 } })).toEqual({ completed: 3, total: 3 });
  });

  it('never lets re-solving one family cover another', () => {
    const steps = [{ family: 'scheduling' }, { family: 'routing' }];
    expect(planStepProgress({ steps, solved: { scheduling: 5 } })).toEqual({ completed: 1, total: 2 });
  });

  it('ignores solves for families outside the plan', () => {
    expect(planStepProgress({ steps: [{ family: 'routing' }], solved: { packing: 3 } })).toEqual({
      completed: 0,
      total: 1,
    });
  });
});
