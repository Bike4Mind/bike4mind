import { describe, expect, it } from 'vitest';
import {
  recommendDlqAction,
  requiresDlqReplayReason,
  type DlqRecommendationFacts,
  type DlqRecommendation,
} from './dlqPolicy';

const cases: [DlqRecommendationFacts, DlqRecommendation['action']][] = [
  [{ category: 'refused', errorType: 'AccessDeniedException' }, 'inspect'],
  [{ category: 'timeout' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: 0, replaySafety: 'safe' }, 'replay'],
  [{ category: 'timeout', replayAttempts: 2, replaySafety: 'safe' }, 'replay'],
  [{ category: 'timeout', replayAttempts: 3, replaySafety: 'safe' }, 'discard'],
  [{ category: 'timeout', replayAttempts: -1, replaySafety: 'safe' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: 0.5, replaySafety: 'safe' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: Number.NaN, replaySafety: 'safe' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: Infinity, replaySafety: 'safe' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: 0, replaySafety: 'unsafe' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: 0, replaySafety: 'side-effects' }, 'inspect'],
  [{ category: 'timeout', replayAttempts: 0 }, 'inspect'],
  [{ category: 'throttle' }, 'inspect'],
  [{ category: 'dependency' }, 'inspect'],
  [{ category: 'bug', errorType: 'ThrottlingException', replayAttempts: 0, replaySafety: 'safe' }, 'replay'],
  [{ category: 'bug', errorType: 'DependencyFailedException', replayAttempts: 0, replaySafety: 'safe' }, 'replay'],
  [{ category: 'bug' }, 'fix-first'],
  [{ category: 'invalid output' }, 'fix-first'],
  [{}, 'inspect'],
  [{ category: 'future' }, 'inspect'],
];
describe('DLQ recommendations from known facts', () => {
  it.each(cases)('handles %j', (facts, action) => expect(recommendDlqAction(facts).action).toBe(action));
  it('names the matched timeout category instead of a generic Error', () => {
    expect(
      recommendDlqAction({ category: 'timeout', errorType: 'Error', replayAttempts: 0, replaySafety: 'safe' }).basis
    ).toBe('Recorded transient failure: timeout.');
  });
  it('does not treat Lambda configuration timestamps as proof of a code fix', () => {
    const facts = { failedAt: '2026-01-01T00:00:00Z', consumerDeployedAt: '2026-01-02T00:00:00Z' };
    expect(recommendDlqAction({ ...facts, category: 'bug' }).action).toBe('fix-first');
    expect(recommendDlqAction({ ...facts, category: 'invalid output' }).action).toBe('fix-first');
    expect(recommendDlqAction(facts)).toMatchObject({
      action: 'inspect',
      label: 'Consumer updated since failure',
      basis: expect.stringContaining('configuration'),
    });
    for (const consumerDeployedAt of [undefined, 'invalid', facts.failedAt, '2025-01-01T00:00:00Z']) {
      expect(recommendDlqAction({ ...facts, consumerDeployedAt }).label).toBe('Inspect first');
    }
  });
  it.each(['side-effects', 'unsafe', 'future-class', undefined])('requires a reason for %s', safety =>
    expect(requiresDlqReplayReason(safety)).toBe(true)
  );
  it('does not require a reason for safe replay', () => expect(requiresDlqReplayReason('safe')).toBe(false));
});
