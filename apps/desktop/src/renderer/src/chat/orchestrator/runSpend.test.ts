import { describe, expect, it } from 'vitest';
import type { CompletionRunUsage } from '@bike4mind/common';
import type { RunSpend } from '@shared/runSpend';
import { describeRunSpend, formatCheckedAt } from './runSpend';

const spend = (creditsCharged: number, requests = 1) => ({
  creditsCharged,
  requests,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function usage(overrides: Partial<CompletionRunUsage> = {}): CompletionRunUsage {
  return {
    runId: 'run-a',
    createdAt: '2026-11-10T00:00:00.000Z',
    settled: spend(30, 6),
    byRole: [
      { ...spend(10, 2), role: 'root' },
      { ...spend(20, 4), role: 'worker' },
    ],
    byPurpose: [
      { ...spend(27, 4), purpose: 'turn' },
      { ...spend(1, 1), purpose: 'title' },
      { ...spend(2, 1), purpose: 'compaction' },
    ],
    byModel: [],
    byAttempt: [
      { ...spend(10, 2), role: 'root' },
      { ...spend(12, 2), role: 'worker', taskId: 'w1', attemptId: 'a1' },
      { ...spend(8, 2), role: 'worker', taskId: 'w2', attemptId: 'a2' },
    ],
    byAttemptTruncated: false,
    ...overrides,
  };
}

const settled = (local: number, server = usage()): RunSpend => ({
  status: 'settled',
  runId: 'run-a',
  local: { creditsCharged: local, requests: 4 },
  server,
  checkedAt: '2026-11-10T00:05:00.000Z',
});

describe('describeRunSpend', () => {
  it("leads with the server's settled total and breaks it down by role and purpose", () => {
    const view = describeRunSpend(settled(27));
    expect(view?.chip).toBe('30 credits settled');
    expect(view?.lines).toEqual([
      'Root 10 credits · Workers 20 credits over 2 attempts',
      'Turns 27 credits · Titles 1 credit · Summaries 2 credits',
      'Turn charges match what this device recorded',
      `Server total as of ${formatCheckedAt('2026-11-10T00:05:00.000Z')}`,
    ]);
    expect(view?.reconciled).toBe(true);
  });

  it('says how far the turn charges are from what this device recorded', () => {
    const view = describeRunSpend(settled(25));
    expect(view?.reconciled).toBe(false);
    expect(view?.lines).toContain('This device recorded 25 credits of the 27 credits in turn charges');
  });

  it('marks a worker attempt count that the server cut short', () => {
    const view = describeRunSpend(settled(27, usage({ byAttemptTruncated: true })));
    expect(view?.lines[0]).toBe('Root 10 credits · Workers 20 credits over 2+ attempts');
  });

  it("falls back to this device's charges, marked as partial, when the server total is unavailable", () => {
    const view = describeRunSpend({
      status: 'unavailable',
      runId: 'run-a',
      local: { creditsCharged: 12, requests: 3 },
      reason: 'offline',
    });
    expect(view).toEqual({
      chip: '~12 credits (this device)',
      lines: ['Server total unavailable; this device can miss helper calls and dropped requests'],
      reconciled: false,
    });
  });

  it('leaves the estimate alone when the server is unavailable and this device recorded nothing', () => {
    expect(
      describeRunSpend({
        status: 'unavailable',
        runId: 'run-a',
        local: { creditsCharged: 0, requests: 0 },
        reason: 'x',
      })
    ).toBeUndefined();
  });

  it('counts each worker as its own attempt', () => {
    const view = describeRunSpend(
      settled(
        27,
        usage({
          byAttempt: [
            { ...spend(5), role: 'worker', taskId: 'w1' },
            { ...spend(5), role: 'worker', taskId: 'w2' },
            { ...spend(10), role: 'worker', taskId: 'w3' },
          ],
        })
      )
    );
    expect(view?.lines[0]).toContain('over 3 attempts');
  });

  it('describes nothing for a run the server never attributed', () => {
    expect(describeRunSpend({ status: 'unattributed' })).toBeUndefined();
    expect(describeRunSpend(undefined)).toBeUndefined();
  });

  it('describes nothing for a value it does not recognise, such as an empty bridge reply', () => {
    expect(describeRunSpend({} as RunSpend)).toBeUndefined();
  });
});
