import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Static-analysis guard on the two confidence-gate call sites. Each must hand the gate the
 * execution's scripted `confidenceOverrides`, or that site silently ignores the script.
 * agentExecutor.confidenceGate.e2e.test.ts drives the post-iteration site end to end, but only
 * in the integration lane, and nothing drives the approval-replay site through the handler.
 */
describe('confidenceOverrides wiring in agentExecutor', () => {
  const source = readFileSync(resolve(__dirname, 'agentExecutor.ts'), 'utf8');

  // The call's first object argument, brace-matched so a later sibling call's copy of the
  // same line cannot satisfy the assertion.
  const firstObjectArg = (opener: string): string => {
    const start = source.indexOf(opener);
    expect(start, `${opener} not found in agentExecutor.ts`).toBeGreaterThan(-1);
    const braceStart = source.indexOf('{', start + opener.length);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(braceStart, i + 1);
    }
    throw new Error(`Unbalanced braces after ${opener}`);
  };

  it.each(['evaluateConfidenceGate(', 'resumeApprovedPauseAndGateConfidence('])(
    'passes the execution script to %s',
    opener => {
      expect(firstObjectArg(opener)).toMatch(/\bconfidenceOverrides\b/);
    }
  );
});
