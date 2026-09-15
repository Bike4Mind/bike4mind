import { describe, expect, it } from 'vitest';
import { shouldPollForSettlingArtifacts } from './questGraphs';

const NOW = new Date('2026-08-01T12:00:00.000Z').getTime();
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

// `completedAt` is typed as a Date by z.infer but arrives as an ISO string over
// the wire; the predicate reads whatever JSON gave it.
const node = (over: Record<string, unknown> = {}) =>
  ({
    status: 'completed',
    artifacts: [],
    completedAt: secondsAgo(5),
    ...over,
  }) as never;

describe('shouldPollForSettlingArtifacts', () => {
  it('polls for a node that just completed with no artifacts yet', () => {
    expect(shouldPollForSettlingArtifacts([node()], NOW)).toBe(true);
  });

  it('stops once the artifacts have landed', () => {
    expect(shouldPollForSettlingArtifacts([node({ artifacts: [{ id: 'a', type: 'react', title: 'A' }] })], NOW)).toBe(
      false
    );
  });

  // Otherwise a run that genuinely produces nothing would poll forever.
  it('stops once the settle window has passed', () => {
    expect(shouldPollForSettlingArtifacts([node({ completedAt: secondsAgo(120) })], NOW)).toBe(false);
  });

  it('ignores nodes that never ran', () => {
    expect(shouldPollForSettlingArtifacts([node({ status: 'pending', completedAt: undefined })], NOW)).toBe(false);
  });

  // The regression this predicate exists for: an earlier version gated on the
  // run having a non-empty answer, so a completed run with a null or empty
  // answer stopped polling immediately and could never pick its artifacts up.
  it('polls regardless of whether the run produced an answer', () => {
    expect(shouldPollForSettlingArtifacts([node({ run: null })], NOW)).toBe(true);
    expect(shouldPollForSettlingArtifacts([node({ run: { answer: '' } })], NOW)).toBe(true);
    expect(shouldPollForSettlingArtifacts([node({ run: { answer: null } })], NOW)).toBe(true);
  });

  it('polls when any one node of several is still settling', () => {
    const settled = node({ artifacts: [{ id: 'a', type: 'react', title: 'A' }] });
    expect(shouldPollForSettlingArtifacts([settled, node()], NOW)).toBe(true);
  });

  it('does not poll for an empty graph', () => {
    expect(shouldPollForSettlingArtifacts([], NOW)).toBe(false);
  });
});
