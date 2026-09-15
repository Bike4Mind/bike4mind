import { describe, it, expect } from 'vitest';
import { mergeChildExecutionsPreferringMoreIterations } from './mergeChildExecutions';
import type { ChildExecution, IterationStep } from '@client/app/stores/useAgentExecutionStore';

// Minimal IterationStep factory - the merge only inspects `iterations.length`.
const steps = (n: number): IterationStep[] =>
  Array.from({ length: n }, (_, i) => ({
    iteration: i,
    // step shape is irrelevant to the merge; cast a stub.
    step: { type: 'thinking' } as IterationStep['step'],
    isComplete: true,
    receivedAt: i,
  }));

const child = (executionId: string, iterCount: number, extra: Partial<ChildExecution> = {}): ChildExecution => ({
  executionId,
  agentName: 'Agent',
  status: 'completed',
  iterations: steps(iterCount),
  ...extra,
});

describe('mergeChildExecutionsPreferringMoreIterations (REST-fallback merge)', () => {
  it('REST wins when it has MORE iterations than the live entry', () => {
    const existing = { c1: child('c1', 1) }; // live: partial (1 step)
    const replayed = { c1: child('c1', 4, { agentName: 'REST' }) }; // REST: full trace
    const merged = mergeChildExecutionsPreferringMoreIterations(existing, replayed);
    expect(merged.c1.iterations).toHaveLength(4);
    expect(merged.c1.agentName).toBe('REST');
  });

  it('LIVE wins when REST has FEWER iterations (in-flight in-process child)', () => {
    const existing = { c1: child('c1', 5, { agentName: 'LIVE' }) }; // live: streaming, ahead
    const replayed = { c1: child('c1', 0, { agentName: 'REST' }) }; // REST: empty (no checkpoint yet)
    const merged = mergeChildExecutionsPreferringMoreIterations(existing, replayed);
    expect(merged.c1.iterations).toHaveLength(5);
    expect(merged.c1.agentName).toBe('LIVE');
  });

  it('LIVE wins on a TIE (REST not strictly greater)', () => {
    const existing = { c1: child('c1', 3, { agentName: 'LIVE' }) };
    const replayed = { c1: child('c1', 3, { agentName: 'REST' }) };
    const merged = mergeChildExecutionsPreferringMoreIterations(existing, replayed);
    expect(merged.c1.agentName).toBe('LIVE');
  });

  it('adds REST-only children not present in the live map', () => {
    const existing = { c1: child('c1', 2) };
    const replayed = { c2: child('c2', 1) };
    const merged = mergeChildExecutionsPreferringMoreIterations(existing, replayed);
    expect(Object.keys(merged).sort()).toEqual(['c1', 'c2']);
  });

  it('preserves live-only children the REST snapshot omitted', () => {
    const existing = { c1: child('c1', 2, { agentName: 'LIVE-ONLY' }) };
    const replayed = {}; // REST returned nothing for this child
    const merged = mergeChildExecutionsPreferringMoreIterations(existing, replayed);
    expect(merged.c1.agentName).toBe('LIVE-ONLY');
  });
});
