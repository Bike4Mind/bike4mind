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
      ranAnyIteration: true,
      finalAnswer: 'a clean answer',
      dagAggregationFallbackSummary: 'unused summary',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: false,
    });
    expect(out).toBe('a clean answer');
  });

  it('falls back to the DAG aggregation summary when a grace iteration ends with no final_answer step', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      ranAnyIteration: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: '# DAG result\n\ncoffee, tea, chocolate summaries here',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: false,
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
      ranAnyIteration: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: 'aggregated report',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: false,
    });
    expect(out).toContain('25-iteration limit');
    expect(out).not.toContain('8-iteration limit');
  });

  it('prefers a real final answer over the DAG fallback when both are present and the run is not over cap', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      ranAnyIteration: true,
      finalAnswer: 'the model did answer before hitting the ceiling',
      dagAggregationFallbackSummary: 'aggregated report',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: false,
    });
    expect(out).toContain('the model did answer before hitting the ceiling');
    expect(out).not.toContain('aggregated report');
  });

  it('still returns a coherent notice when neither a final answer nor a DAG summary exists', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      ranAnyIteration: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: undefined,
      configuredMaxIterations: 10,
      isOverCapGraceIteration: false,
    });
    expect(out).toContain('10-iteration limit');
  });

  it('uses the honest credit-cap message, not the misleading iteration-limit one, on the over-cap grace path', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      ranAnyIteration: true,
      finalAnswer: undefined,
      dagAggregationFallbackSummary: 'aggregated report',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: true,
    });
    expect(out).toContain('aggregated report');
    expect(out).toContain('credit cap');
    // Neither the run's ceiling nor the internal clamp size should appear - a
    // credit-cap stop is not an iteration-count story.
    expect(out).not.toContain('25-iteration limit');
    expect(out).not.toContain('8-iteration limit');
    // The generic advice is a dead end here: a follow-up hits the same cap gate.
    expect(out).not.toMatch(/send a follow-up to continue/i);
  });

  it("prefers the DAG summary over ReActAgent's own synthesized ceiling notice on the over-cap grace path (the actual caller shape)", () => {
    // ReActAgent never actually returns finalAnswer === undefined when reachedMaxIterations
    // is true - it synthesizes this exact notice first. A prior version of this function
    // only fell back to the summary on finalAnswer === undefined, so it never fired for the
    // real caller and silently dropped the aggregated report every time.
    const out = resolveDisplayAnswer({
      reachedMaxIterations: true,
      ranAnyIteration: true,
      finalAnswer: 'I reached the maximum number of iterations (8/8) without arriving at a final answer.',
      dagAggregationFallbackSummary: '# DAG result\n\ncoffee, tea, chocolate summaries here',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: true,
    });
    expect(out).toContain('coffee, tea, chocolate summaries here');
    // The clamped grant size must not leak through as if it were the run's real ceiling.
    expect(out).not.toContain('8/8');
    expect(out).not.toContain('8-iteration limit');
  });

  it('uses the fresh DAG summary, not a stale earlier final_answer, when the wake left no room for a grace iteration to run', () => {
    // iterationIndex was already at or past configuredMaxIterations when the aggregation
    // splice happened, so the loop never runs this invocation - `finalAnswer` here would be
    // read from an EARLIER iteration's checkpoint, not this wake's result.
    const out = resolveDisplayAnswer({
      reachedMaxIterations: false,
      ranAnyIteration: false,
      finalAnswer: 'a stale answer from a much earlier iteration',
      dagAggregationFallbackSummary: 'the fresh aggregated report',
      configuredMaxIterations: 25,
      isOverCapGraceIteration: true,
    });
    expect(out).toBe('the fresh aggregated report');
  });

  it('falls back to the stale final answer only when no fresh DAG summary exists either', () => {
    const out = resolveDisplayAnswer({
      reachedMaxIterations: false,
      ranAnyIteration: false,
      finalAnswer: 'a stale answer from a much earlier iteration',
      dagAggregationFallbackSummary: undefined,
      configuredMaxIterations: 25,
      isOverCapGraceIteration: false,
    });
    expect(out).toBe('a stale answer from a much earlier iteration');
  });
});
