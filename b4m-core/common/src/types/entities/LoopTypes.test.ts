import { describe, it, expect } from 'vitest';
import { effectiveMergePolicy } from './LoopTypes';

describe('effectiveMergePolicy', () => {
  it('defaults to review and serves green-ci as review when the org turned it off', () => {
    expect(effectiveMergePolicy(undefined)).toBe('review');
    expect(effectiveMergePolicy('green-ci')).toBe('green-ci');
    expect(effectiveMergePolicy('green-ci', true)).toBe('review');
    expect(effectiveMergePolicy('never', true)).toBe('never');
  });
});
