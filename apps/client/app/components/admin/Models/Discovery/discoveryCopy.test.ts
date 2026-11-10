import { describe, it, expect } from 'vitest';
import {
  countLabel,
  formatRunTime,
  nextScheduledRun,
  runChangeSummary,
  runResult,
  runSentence,
  sourceTally,
} from './discoveryCopy';
import { EMPTY_CHANGES, runWith } from './__tests__/discoveryTestKit';

const counts = { added: 0, promoted: 0, deprecated: 0, repriced: 0, flagged: 0 };
const listed = (trigger: string, startedAt: string) => ({
  id: startedAt,
  startedAt,
  finishedAt: startedAt,
  trigger,
  host: 'hosted',
  status: 'ok' as const,
  mode: 'write' as const,
  changes: counts,
});

describe('sourceTally', () => {
  it('counts every attempted source as ok when none failed', () => {
    expect(sourceTally([{ ok: true }, { ok: true }])).toBe('2 of 2 sources ok');
  });

  it('reports zero ok rather than no attempt when every attempted source failed', () => {
    expect(sourceTally([{ ok: false }])).toBe('0 of 1 source ok');
  });

  it('says nothing was attempted for an empty run', () => {
    expect(sourceTally([])).toBe('no sources attempted');
  });
});

describe('runResult', () => {
  it.each([
    [{ status: 'ok', finishedAt: null, mode: 'write' }, 'Running', 'info'],
    [{ status: 'failed', finishedAt: 'x', mode: 'write' }, 'Failed', 'bad'],
    [{ status: 'ok', finishedAt: 'x', mode: 'write' }, 'Finished', 'good'],
    [{ status: 'ok', finishedAt: 'x', mode: 'report' }, 'Report only', 'neutral'],
    [{ status: 'partial', finishedAt: 'x', mode: 'write' }, 'Finished, some sources failed', 'warn'],
    [
      { status: 'partial', finishedAt: 'x', mode: 'report', sources: [{ ok: false }, { ok: true }] },
      'Report only, 1 source failed',
      'warn',
    ],
  ] as const)('reads %o as %s', (run, label, tone) => {
    expect(runResult(run)).toEqual({ label, tone });
  });
});

describe('runChangeSummary', () => {
  it('words the counts and marks a report run as not saved', () => {
    expect(runChangeSummary({ ...counts, added: 2, flagged: 1 }, 'write')).toBe('2 new models, 1 price to review');
    expect(runChangeSummary({ ...counts, promoted: 3 }, 'report')).toBe('3 listed (not saved)');
    expect(runChangeSummary(counts, 'write')).toBe('No changes');
  });
});

describe('runSentence', () => {
  it('names new models, what blocks them and failed sources', () => {
    const run = runWith({
      priceFlags: [],
      sources: [{ name: 'a', ok: false, durationMs: 1 }],
      changes: { ...EMPTY_CHANGES, added: ['m1', 'm2'], promoted: ['m1'] },
      catalogDiff: [
        {
          modelId: 'm2',
          kind: 'added',
          ownedGroups: [],
          changedKeys: [],
          lifecycleStatus: 'active',
          promoted: false,
          blockedBy: ['no-trusted-price'],
          operatorOwned: false,
        },
      ],
    });
    expect(runSentence(run)).toBe('Found 2 new models. Listed 1. 1 needs a price. 1 source failed.');
    expect(runSentence({ ...run, mode: 'report' })).toContain('Would list 1.');
  });

  it('says No changes for a quiet run', () => {
    expect(runSentence(runWith({ sources: [], changes: EMPTY_CHANGES }))).toBe('No changes.');
  });
});

describe('nextScheduledRun', () => {
  const now = new Date('2026-07-26T14:00:00.000Z');

  it('projects six hours past the last scheduled run, skipping a manual one', () => {
    const next = nextScheduledRun(
      [listed('manual', '2026-07-26T13:00:00.000Z'), listed('cron', '2026-07-26T12:20:00.000Z')],
      now
    );
    expect(next?.toISOString()).toBe('2026-07-26T18:20:00.000Z');
  });

  it('is unknown without a scheduled run, or when the last one is over two intervals old', () => {
    expect(nextScheduledRun([listed('manual', '2026-07-26T13:00:00.000Z')], now)).toBeNull();
    expect(nextScheduledRun([listed('cron', '2026-07-25T23:00:00.000Z')], now)).toBeNull();
  });
});

describe('formatRunTime and countLabel', () => {
  it('says Today and Yesterday for recent runs', () => {
    const now = new Date(2026, 6, 26, 15, 0);
    expect(formatRunTime(new Date(2026, 6, 26, 9, 12).toISOString(), now)).toMatch(/^Today /);
    expect(formatRunTime(new Date(2026, 6, 25, 18, 20).toISOString(), now)).toMatch(/^Yesterday /);
    expect(formatRunTime(null, now)).toBe('-');
  });

  it('never passes a capped slice off as the whole set', () => {
    expect(countLabel(200, 240)).toBe('first 200 of 240');
    expect(countLabel(3, 3)).toBe('3');
    expect(countLabel(3, undefined)).toBe('3');
  });
});
