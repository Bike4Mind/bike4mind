import { describe, expect, it } from 'vitest';
import {
  DLQ_NEXT_RUN_SETTLE_MS,
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

describe('DLQ recommendations for stale dead letters', () => {
  const now = Date.parse('2026-03-03T00:00:00Z');
  const scheduled = { staleWhen: 'superseded-schedule' as const, scheduledAt: '2026-03-01T00:00:00.000Z', now };

  it('discards a self-healing queue message as obsolete', () => {
    expect(recommendDlqAction({ staleWhen: 'self-healing', category: 'bug' })).toMatchObject({
      action: 'discard',
      label: 'Job obsolete, discard',
      basis: expect.stringContaining('Retried by normal use'),
    });
  });

  it('discards a scheduled run once the next run has been due for a day without dead-lettering', () => {
    expect(recommendDlqAction({ ...scheduled, nextRunDueAt: '2026-03-01T01:00:00.000Z' })).toEqual({
      action: 'discard',
      label: 'Job obsolete, discard',
      basis:
        'Scheduled run at 2026-03-01T00:00:00.000Z; the next run, due at 2026-03-01T01:00:00.000Z, is not in this dead-letter queue a day later. Each run processes current state.',
    });
  });

  it('waits a day after the next run was due, so a failure still being retried can land first', () => {
    const due = new Date(now - DLQ_NEXT_RUN_SETTLE_MS + 60_000).toISOString();
    expect(recommendDlqAction({ ...scheduled, nextRunDueAt: due }).label).toBe('Inspect first');
  });

  it('falls through when the next run is not yet due, unknown, or the scheduled time is missing', () => {
    expect(recommendDlqAction({ ...scheduled, nextRunDueAt: '2026-03-03T00:00:00.000Z' }).label).toBe('Inspect first');
    expect(recommendDlqAction(scheduled).label).toBe('Inspect first');
    expect(
      recommendDlqAction({ ...scheduled, scheduledAt: undefined, nextRunDueAt: '2026-03-01T01:00:00.000Z' }).label
    ).toBe('Inspect first');
  });

  it('leaves an unflagged queue unchanged', () => {
    expect(
      recommendDlqAction({ scheduledAt: scheduled.scheduledAt, nextRunDueAt: '2026-03-01T01:00:00.000Z', now }).label
    ).toBe('Inspect first');
  });

  it('keeps the replay attempt limit ahead of staleness', () => {
    expect(recommendDlqAction({ staleWhen: 'self-healing', replayAttempts: 3 }).label).toBe('Discard');
  });
});
