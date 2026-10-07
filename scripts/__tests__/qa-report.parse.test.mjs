import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capTests,
  cleanError,
  creditsMetrics,
  CREDITS_THRESHOLD,
  ERROR_MAX_CHARS,
  latencyMetric,
  mergeParsed,
  parseResults,
  suiteDisplayName,
} from '../qa-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/pw-results.json'), 'utf8'));

describe('parseResults', () => {
  it('counts exactly like the e2e-run.yml jq', () => {
    expect(parseResults(fixture()).counts).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
      notStarted: 1,
      ran: 4,
      total: 4,
    });
  });

  it('builds the suite summary the Slack post shows', () => {
    expect(parseResults(fixture()).suiteSummary).toEqual([
      { name: 'Notebook', passed: 3, ran: 4, notRun: 0 },
      { name: 'Data Lake', passed: 0, ran: 0, notRun: 1 },
    ]);
  });

  it('maps statuses and keys, setup tests included', () => {
    expect(parseResults(fixture()).tests.map(t => [t.testKey, t.status, t.retries])).toEqual([
      ['core.setup.ts > create admin', 'passed', 0],
      ['notebook.spec.ts > Notebook > creates', 'passed', 0],
      ['notebook.spec.ts > Notebook > saves', 'failed', 2],
      ['notebook.spec.ts > Notebook > renames', 'flaky', 1],
      ['notebook.spec.ts > Notebook > archives', 'skipped', 0],
      ['data-lake.spec.ts > imports', 'notStarted', 0],
    ]);
  });

  it('keeps screenshot, video and trace attachments for failed tests only', () => {
    const tests = parseResults(fixture()).tests;
    expect(tests[2].attachments.map(a => a.name)).toEqual(['screenshot', 'video', 'trace']);
    expect(tests.filter(t => t.attachments.length > 0)).toHaveLength(1);
  });

  it('takes the trace from an earlier attempt when the last one has none', () => {
    const report = fixture();
    const results = report.suites[1].suites[0].specs[1].tests[0].results;
    const trace = results[2].attachments.find(a => a.name === 'trace');
    results[2].attachments = results[2].attachments.filter(a => a !== trace);
    results[1].attachments = [trace];
    const failed = parseResults(report).tests[2];
    expect(failed.attachments.map(a => a.name)).toEqual(['screenshot', 'video', 'trace']);
    expect(failed.attachments[2].path).toBe('__ATTACH__/trace.zip');
  });

  it('uses the last failing attempt for the error, and the first failure for flaky', () => {
    const tests = parseResults(fixture()).tests;
    expect(tests[2].error).toBe('expect(locator).toBeVisible() failed');
    expect(tests[3].error).toBe('flaked once');
    expect(tests[1].error).toBeUndefined();
  });

  it('reads start time and duration', () => {
    const p = parseResults(fixture());
    expect(new Date(p.startMs).toISOString()).toBe('2026-09-28T09:00:00.000Z');
    expect(p.endMs - p.startMs).toBe(252000);
  });

  it('returns zero counts for an empty report', () => {
    expect(parseResults({}).counts).toEqual({ passed: 0, failed: 0, skipped: 0, notStarted: 0, ran: 0, total: 0 });
  });
});

describe('suiteDisplayName', () => {
  it('matches the jq title-casing', () => {
    expect(suiteDisplayName('data-lake.spec.ts')).toBe('Data Lake');
    expect(suiteDisplayName('e2e/ai-latency_short.spec.ts')).toBe('Ai Latency Short');
  });
});

describe('cleanError', () => {
  it('strips ANSI and truncates errors to 4000 chars', () => {
    const msg = cleanError({ errors: [{ message: `\u001b[31m${'x'.repeat(5000)}\u001b[39m` }] });
    expect(msg).not.toContain('\u001b');
    expect(msg).toHaveLength(ERROR_MAX_CHARS);
    expect(msg.endsWith('...')).toBe(true);
  });
  it('falls back to result.error', () => {
    expect(cleanError({ error: { message: 'boom' } })).toBe('boom');
  });
});

describe('capTests', () => {
  it('caps tests at 2000 keeping every non-passed test', () => {
    const tests = [
      ...Array.from({ length: 2500 }, (_, i) => ({ testKey: `p${i}`, status: 'passed' })),
      { testKey: 'f', status: 'failed' },
      { testKey: 'n', status: 'notStarted' },
    ];
    const capped = capTests(tests);
    expect(capped).toHaveLength(2000);
    expect(capped.map(t => t.testKey)).toEqual(expect.arrayContaining(['f', 'n']));
  });
});

describe('mergeParsed', () => {
  it('prefixes labels and sums counts', () => {
    const merged = mergeParsed([
      parseResults(fixture(), { label: 'cell-a' }),
      parseResults(fixture(), { label: 'cell-b' }),
    ]);
    expect(merged.counts).toEqual({ passed: 6, failed: 2, skipped: 0, notStarted: 2, ran: 8, total: 8 });
    expect(merged.tests[0].testKey).toBe('cell-a::core.setup.ts > create admin');
    expect(merged.suiteSummary[2].name).toBe('cell-b Notebook');
  });
});

describe('metric adapters', () => {
  it('maps credits.json and drops missing values', () => {
    expect(
      creditsMetrics([
        { model: 'model-x', avgCredits: 12.5, avgDuration: null, successRate: '2/2' },
        { model: 'model-y', avgCredits: null, avgDuration: null, successRate: '0/2' },
      ])
    ).toEqual([{ kind: 'credits', model: 'model-x', value: 12.5, unit: 'credits', threshold: 60 }]);
  });

  it('keeps the credits threshold in step with apps/client/e2e/helpers/slack.ts', () => {
    const slack = fs.readFileSync(path.join(here, '../../apps/client/e2e/helpers/slack.ts'), 'utf8');
    expect(slack).toMatch(new RegExp(`CREDITS_THRESHOLD\\s*=\\s*${CREDITS_THRESHOLD}\\b`));
  });

  it('maps a latency results file and treats 0 as no data', () => {
    expect(
      latencyMetric('/x/ai-latency-short-answers-results.json', {
        model: 'model-x',
        thresholdSec: 5,
        averageResponseTimeSec: 3.2,
      })
    ).toEqual({
      kind: 'latency',
      model: 'model-x',
      label: 'ai-latency-short-answers',
      value: 3.2,
      unit: 's',
      threshold: 5,
    });
    expect(
      latencyMetric('/x/a-results.json', { model: 'model-x', thresholdSec: 5, averageResponseTimeSec: 0 })
    ).toBeNull();
  });
});
