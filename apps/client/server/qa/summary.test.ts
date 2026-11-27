import { describe, it, expect } from 'vitest';
import type { QaMetric } from '@bike4mind/common';
import { SCHEDULED_TRIGGER, summarizeQaRuns, type QaSummaryRunInput } from './summary';

const run = (o: Partial<QaSummaryRunInput> & { failed?: number; notStarted?: number; passed?: number }) => {
  const { failed = 0, notStarted = 0, passed = 10, ...rest } = o;
  return {
    product: 'product-a',
    suite: 'Full',
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

describe('SCHEDULED_TRIGGER', () => {
  it('matches the CI schedule label and the GitHub event name, not other triggers', () => {
    expect(['Run via Schedule', 'schedule'].every(t => SCHEDULED_TRIGGER.test(t))).toBe(true);
    expect(
      ['Run via Dispatch', 'workflow_dispatch', 'Run via Deployer', 'push'].some(t => SCHEDULED_TRIGGER.test(t))
    ).toBe(false);
  });
});

describe('summarizeQaRuns', () => {
  it('totals every suite of a product', () => {
    const [p] = summarizeQaRuns([
      run({ passed: 9, failed: 1 }),
      run({}),
      run({ suite: 'Core', passed: 4, notStarted: 1 }),
    ]);
    expect(p.e2e).toEqual({ runs: 3, cleanRuns: 1, passed: 23, tests: 25, passRate: 23 / 25 });
    expect(p.latency).toBeNull();
  });

  it('counts an infra-error run as not clean even with zero failures', () => {
    const [p] = summarizeQaRuns([run({}), { ...run({ passed: 0 }), status: 'infra-error' }]);
    expect(p.e2e).toMatchObject({ runs: 2, cleanRuns: 1, passRate: 1 });
  });

  it('treats a suite with latency metrics as latency, including its runs with no result', () => {
    const [p] = summarizeQaRuns([
      run({ suite: 'AI Latency', metrics: [latency(5, 10), latency(12, 10), latency(3)] }),
      run({ suite: 'AI Latency', metrics: [latency(4, 10)] }),
      { ...run({ suite: 'AI Latency', passed: 0 }), status: 'infra-error', metrics: [] },
      run({ suite: 'Core' }),
    ]);
    // The infra-error run ran no test, so it still counts one check over the limit.
    expect(p.latency).toEqual({ runs: 3, passedRuns: 1, checks: 4, checksWithinLimit: 2, checkRate: 0.5 });
    expect(p.e2e).toMatchObject({ runs: 1, cleanRuns: 1 });
  });

  it('counts each test of a run that reported no check as a check over the limit', () => {
    const ok = [latency(20, 60), latency(25, 60), latency(30, 60), latency(22, 60)];
    const [p] = summarizeQaRuns([
      run({ suite: 'AI Latency', passed: 4, metrics: ok }),
      run({ suite: 'AI Latency', passed: 4, metrics: ok }),
      { ...run({ suite: 'AI Latency', passed: 0, failed: 4 }), metrics: [] },
    ]);
    expect(p.latency).toEqual({ runs: 3, passedRuns: 2, checks: 12, checksWithinLimit: 8, checkRate: 8 / 12 });
  });

  it('does not count a run that reported latency values without a limit as crashed', () => {
    const [p] = summarizeQaRuns([run({ suite: 'AI Latency', passed: 4, metrics: [latency(5), latency(7)] })]);
    expect(p.latency).toEqual({ runs: 1, passedRuns: 1, checks: 0, checksWithinLimit: 0, checkRate: null });
  });

  it('passes a latency run only when its status passed and every check is within its limit', () => {
    const [p] = summarizeQaRuns([
      run({ suite: 'AI Latency', passed: 4, metrics: [latency(50, 60), latency(70, 60), latency(40, 60)] }),
      run({ suite: 'AI Latency', passed: 3, failed: 1, metrics: [latency(10, 60)] }),
      run({ suite: 'AI Latency', passed: 1, metrics: [latency(10, 60), latency(5)] }),
    ]);
    expect(p.latency).toMatchObject({ runs: 3, passedRuns: 1, checks: 5, checksWithinLimit: 4 });
  });

  it('counts a known latency suite as latency even when none of its runs here has a metric', () => {
    const runs = [
      run({ suite: 'Full' }),
      { ...run({ suite: 'AI Latency', passed: 0, failed: 4 }), metrics: [] },
      run({ product: 'product-b', suite: 'AI Latency', passed: 0, failed: 1 }),
    ];
    const [a, b] = summarizeQaRuns(runs, new Map([['product-a', new Set(['AI Latency'])]]));
    expect(a.e2e).toMatchObject({ runs: 1, cleanRuns: 1, passRate: 1 });
    expect(a.latency).toEqual({ runs: 1, passedRuns: 0, checks: 4, checksWithinLimit: 0, checkRate: 0 });
    // Known suites are per product: product-b's AI Latency has no metric anywhere, so it stays E2E.
    expect(b.latency).toBeNull();
    expect(b.e2e).toMatchObject({ runs: 1, cleanRuns: 0 });
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
