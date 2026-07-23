import { describe, it, expect } from 'vitest';
import { isModellessAgent } from './ModellessAgentWarning';

// Pins the falsy semantics every warning surface shares: '' and unset both
// mean "System Default"; an unknown agent is never flagged.
describe('isModellessAgent', () => {
  it('flags an agent with no preferredModel field', () => {
    expect(isModellessAgent({})).toBe(true);
  });

  it('flags an agent with an empty-string preferredModel', () => {
    expect(isModellessAgent({ preferredModel: '' })).toBe(true);
  });

  it('does not flag an agent with an explicit model', () => {
    expect(isModellessAgent({ preferredModel: 'claude-test' })).toBe(false);
  });

  it('does not flag an unknown agent', () => {
    expect(isModellessAgent(undefined)).toBe(false);
    expect(isModellessAgent(null)).toBe(false);
  });
});
