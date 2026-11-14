import { describe, it, expect } from 'vitest';
import type { QaMetric } from '@bike4mind/common';
import { summarizeQaRuns, triggerKind, type QaSummaryRunInput } from './summary';

const run = (o: Partial<QaSummaryRunInput> & { failed?: number; notStarted?: number; passed?: number }) => {
  const { failed = 0, notStarted = 0, passed = 10, ...rest } = o;
  return {
    product: 'product-a',
    suite: 'Full',
    trigger: 'Run via Schedule',
    status: failed > 0 ? 'failed' : 'passed',
    counts: { passed, failed, skipped: 0, notStarted, ran: passed + failed, total: passed + failed + notStarted },
    ...rest,
  } as QaSummaryRunInput;
};

const latency = (value: number, threshold?: number): QaMetric => ({
  kind: 'latency',
  model: 'model-a',
  value,
  unit: 's',
  ...(threshold !== undefined ? { threshold } : {}),
});

describe('triggerKind', () => {
  it('maps the CI trigger labels and GitHub event names', () => {
    expect(triggerKind('Run via Schedule')).toBe('scheduled');
    expect(triggerKind('schedule')).toBe('scheduled');
    expect(triggerKind('Run via Dispatch')).toBe('manual');
    expect(triggerKind('workflow_dispatch')).toBe('manual');
    expect(triggerKind('Run via Deployer')).toBe('deploy');
    expect(triggerKind('push')).toBe('other');
  });
});

describe('summarizeQaRuns', () => {
  it('splits a suite by trigger and totals every trigger for the product', () => {
    const [p] = summarizeQaRuns([
      run({ trigger: 'Run via Schedule', passed: 9, failed: 1 }),
      run({ trigger: 'Run via Schedule' }),
      run({ trigger: 'Run via Dispatch' }),
      run({ suite: 'Core', trigger: 'Run via Deployer', passed: 4, notStarted: 1 }),
    ]);
    expect(p.e2e).toEqual({ runs: 4, cleanRuns: 2, passed: 33, tests: 35, passRate: 33 / 35 });
    expect(p.latency).toBeNull();
    expect(p.rows.map(r => [r.suite, r.triggerLabel, r.stats.runs])).toEqual([
      ['Core', 'After deploy', 1],
      ['Full', 'Scheduled', 2],
      ['Full', 'Manual dispatch', 1],
    ]);
    const scheduled = p.rows[1];
    expect(scheduled.kind === 'e2e' && scheduled.stats).toEqual({
      runs: 2,
      cleanRuns: 1,
      passed: 19,
      tests: 20,
      passRate: 0.95,
    });
  });

  it('counts an infra-error run as not clean even with zero failures', () => {
    const [p] = summarizeQaRuns([run({}), { ...run({ passed: 0 }), status: 'infra-error' }]);
    expect(p.e2e).toMatchObject({ runs: 2, cleanRuns: 1, passRate: 1 });
  });

  it('keeps an unknown trigger under its own label', () => {
    const [p] = summarizeQaRuns([run({ trigger: 'push' })]);
    expect(p.rows[0]).toMatchObject({ trigger: 'other', triggerLabel: 'push' });
  });

  it('treats a suite with latency metrics as latency, including its runs with no result', () => {
    const [p] = summarizeQaRuns([
      run({ suite: 'AI Latency', metrics: [latency(5, 10), latency(12, 10), latency(3)] }),
      run({ suite: 'AI Latency', metrics: [latency(4, 10)] }),
      { ...run({ suite: 'AI Latency', passed: 0 }), status: 'infra-error', metrics: [] },
      run({ suite: 'Core', trigger: 'Run via Deployer' }),
    ]);
    expect(p.latency).toEqual({ runs: 3, passedRuns: 2, checks: 3, checksWithinLimit: 2, checkRate: 2 / 3 });
    expect(p.e2e).toMatchObject({ runs: 1, cleanRuns: 1 });
    expect(p.rows.map(r => [r.kind, r.suite])).toEqual([
      ['e2e', 'Core'],
      ['latency', 'AI Latency'],
    ]);
  });

  it('gives one card per product, sorted, with null figures when a kind has no runs', () => {
    const out = summarizeQaRuns([
      run({ product: 'product-b', suite: 'AI Latency', metrics: [latency(1, 10)] }),
      run({ product: 'product-a', passed: 0 }),
    ]);
    expect(out.map(p => p.product)).toEqual(['product-a', 'product-b']);
    expect(out[0].e2e?.passRate).toBeNull();
    expect(out[1].e2e).toBeNull();
    expect(out[1].latency?.checkRate).toBe(1);
  });
});
