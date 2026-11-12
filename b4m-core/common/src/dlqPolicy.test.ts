import { describe, expect, it } from 'vitest';
import { recommendDlqAction, requiresDlqReplayReason } from './dlqPolicy';

describe('DLQ fact-based recommendations', () => {
  it.each([
    [{ category: 'refused' }, 'discard'],
    [{ category: 'timeout' }, 'replay'],
    [{ category: 'throttle' }, 'replay'],
    [{ category: 'dependency' }, 'replay'],
    [{ category: 'bug', errorType: 'ThrottlingException' }, 'replay'],
    [{ category: 'bug', errorType: 'DependencyFailedException' }, 'replay'],
    [{ category: 'bug', consumerVersion: '2', runningConsumerVersion: '2' }, 'fix-first'],
    [{ category: 'invalid output' }, 'fix-first'],
    [{}, 'inspect'],
    [{ category: 'unknown' }, 'inspect'],
    [{ category: 'timeout', replayAttempts: 3 }, 'discard'],
    [{ category: 'timeout', replayAttempts: 2 }, 'replay'],
  ])('uses recorded facts %j', (facts, action) => {
    const result = recommendDlqAction(facts);
    expect(result.action).toBe(action);
    expect(result.basis.length).toBeGreaterThan(0);
  });

  it('only claims possibly fixed for a strictly newer recorded deployment', () => {
    const facts = { category: 'bug', failedAt: '2026-01-01T00:00:00Z', consumerDeployedAt: '2026-01-02T00:00:00Z' };
    expect(recommendDlqAction(facts).label).toBe('Possibly fixed since: replay');
    for (const consumerDeployedAt of [undefined, 'invalid', facts.failedAt, '2025-01-01T00:00:00Z']) {
      expect(recommendDlqAction({ ...facts, consumerDeployedAt }).action).toBe('fix-first');
    }
    expect(recommendDlqAction({ ...facts, category: 'refused' }).action).toBe('discard');
    expect(recommendDlqAction({ ...facts, replayAttempts: 3 }).action).toBe('discard');
  });

  it('does not treat mutable or unknown versions as proof of the same code', () => {
    for (const consumerVersion of ['$LATEST', 'unknown', undefined]) {
      expect(
        recommendDlqAction({ category: 'bug', consumerVersion, runningConsumerVersion: consumerVersion }).basis
      ).toContain('no newer consumer deployment is confirmed');
    }
  });

  it.each(['side-effects', 'unsafe', 'future-class', undefined])('requires a reason for %s', safety => {
    expect(requiresDlqReplayReason(safety)).toBe(true);
  });
  it('does not require a reason for safe replay', () => expect(requiresDlqReplayReason('safe')).toBe(false));
});
