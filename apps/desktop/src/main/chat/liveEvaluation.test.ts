import { describe, expect, it } from 'vitest';
import { effectiveEvaluationArms } from './liveEvaluation';

describe('effective evaluation arms', () => {
  it('runs only the reference for the pinned OpenAI model', () => {
    const arms = effectiveEvaluationArms({ id: 'gpt-6.1-sol', name: 'Pinned model', backend: 'openai' });
    expect(arms).toEqual([
      { name: 'reference', deferred: false, skip: false },
      { name: 'deferred-zero', deferred: false, skip: true },
    ]);
    expect(arms.filter(arm => !arm.skip)).toHaveLength(1);
  });

  it('does not treat an unknown backend as supporting deferral', () => {
    expect(effectiveEvaluationArms({ id: 'unknown', name: 'Unknown' }).filter(arm => !arm.skip)).toHaveLength(1);
  });
});
