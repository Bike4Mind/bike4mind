import { describe, it, expect } from 'vitest';
import { buildTruncatedRunReply, resolveDisplayAnswer } from './truncatedReply';

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

describe('resolveDisplayAnswer', () => {
  it('returns the final answer unchanged when the run did not hit its ceiling', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: false,
      finalAnswer: 'a clean answer',
      dagAggregationFallbackSummary: 'unused summary',
      configuredMaxIterations: 25,
    });
    expect(out).toBe('a clean answer');
  });

  it('falls back to the DAG aggregation summary when a grace iteration ends with no final_answer step', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: '# DAG result\n\ncoffee, tea, chocolate summaries here',
      configuredMaxIterations: 25,
    });
    expect(out).toContain('coffee, tea, chocolate summaries here');
    // Must not be silently dropped - the whole point of the fallback.
    expect(out).not.toBe(
      'This run reached its 25-iteration limit before finishing, so the result below is partial.\n\nSend a follow-up to continue from where this left off.'
    );
  });

  it('uses the configured ceiling, not a clamped one, in the truncation message', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: 'aggregated report',
      configuredMaxIterations: 25,
    });
    expect(out).toContain('25-iteration limit');
    expect(out).not.toContain('8-iteration limit');
  });

  it('prefers a real final answer over the DAG fallback when both are present', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      finalAnswer: 'the model did answer before hitting the ceiling',
      dagAggregationFallbackSummary: 'aggregated report',
      configuredMaxIterations: 25,
    });
    expect(out).toContain('the model did answer before hitting the ceiling');
    expect(out).not.toContain('aggregated report');
  });

  it('still returns a coherent notice when neither a final answer nor a DAG summary exists', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: undefined,
      configuredMaxIterations: 10,
    });
    expect(out).toContain('10-iteration limit');
  });
});
