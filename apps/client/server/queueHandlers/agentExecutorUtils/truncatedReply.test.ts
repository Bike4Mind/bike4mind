import { describe, it, expect } from 'vitest';
import { buildTruncatedRunReply } from './truncatedReply';

describe('buildTruncatedRunReply', () => {
  it('states the run was truncated and names the iteration limit', () => {
    const out = buildTruncatedRunReply(30, 'Solved steps 1 and 2.');
    expect(out).toContain('30-iteration limit');
    expect(out).toMatch(/partial/i);
  });

  it('includes the partial answer when one exists', () => {
    const out = buildTruncatedRunReply(30, 'Solved steps 1 and 2.');
    expect(out).toContain('Solved steps 1 and 2.');
    expect(out).toMatch(/continue/i);
  });

  it('still returns a coherent notice when there is no partial answer', () => {
    const out = buildTruncatedRunReply(16);
    expect(out).toContain('16-iteration limit');
    expect(out).toMatch(/continue/i);
    // No stray blank block where the (absent) partial answer would go.
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('trims whitespace-only answers to the no-partial form', () => {
    const withPartial = buildTruncatedRunReply(30, 'real content');
    const whitespaceOnly = buildTruncatedRunReply(30, '   \n  ');
    const noArg = buildTruncatedRunReply(30);
    expect(whitespaceOnly).toBe(noArg);
    expect(withPartial).not.toBe(noArg);
  });
});
