import { describe, it, expect } from 'vitest';
import {
  assertBudgetConfig,
  completedResult,
  gatedAverageSec,
  incompleteResult,
  mergeResults,
  msToSec,
  textStreamBudgetMs,
} from '../../../apps/client/e2e/ai-latency-budget';
import type { PromptScenario, PromptResult } from '../../../apps/client/e2e/ai-latency-helpers';

/**
 * Guard: the ai-latency suite's time budgets and result bookkeeping.
 *
 * Lives here rather than beside the module because `apps/client/e2e` is excluded from every
 * vitest project (apps/client/vitest.config.mts, LANE_EXCLUDE) - a co-located test would match no
 * project and never run, which is the same silent-no-op class this suite exists to catch. The
 * module under test is deliberately dependency-free so it can be imported outside a Playwright
 * runner; if it ever grows a Playwright import, this file stops compiling and that is the signal.
 *
 * The rules pinned here are the ones whose regression is invisible at runtime: a budget that
 * quietly reverts to the flat cap still passes every e2e run (the prompt just fails as a "hang"
 * again), and a merge that drops an incomplete result still produces a perfectly well-formed
 * results file - one that reports a healthy average for a cell that timed out.
 */

const scenario = (over: Partial<PromptScenario> = {}): PromptScenario => ({
  id: 'p',
  prompt: 'prompt text',
  expectedKeywords: ['k'],
  ...over,
});

describe('textStreamBudgetMs', () => {
  it('never returns less than the flat AI_RESPONSE floor', () => {
    // Suites declaring 30/60/90s must not end up with a cap TIGHTER than the legacy 120s.
    for (const thresholdSec of [30, 60, 90]) {
      expect(textStreamBudgetMs(thresholdSec, scenario())).toBe(120_000);
    }
  });

  it('rises to the declared threshold when that exceeds the floor', () => {
    // The whole point of the first commit: 150s declared must not be capped at 120s.
    expect(textStreamBudgetMs(150, scenario())).toBe(150_000);
  });

  it('lets a scenario override the suite threshold', () => {
    expect(textStreamBudgetMs(150, scenario({ textStreamingBudgetSec: 300 }))).toBe(300_000);
  });

  it('floors an override that would be tighter than AI_RESPONSE', () => {
    expect(textStreamBudgetMs(150, scenario({ textStreamingBudgetSec: 0 }))).toBe(120_000);
    expect(textStreamBudgetMs(150, scenario({ textStreamingBudgetSec: 10 }))).toBe(120_000);
  });
});

describe('assertBudgetConfig', () => {
  it('rejects a budget on a prompt that can never read it', () => {
    // Image/artifact prompts always take IMAGE_GENERATION, so the field would be dead config.
    expect(() =>
      assertBudgetConfig([scenario({ id: 'img', textStreamingBudgetSec: 300, expectsImage: true })])
    ).toThrow(/ignored for image\/artifact prompts.*img/s);
    expect(() =>
      assertBudgetConfig([scenario({ id: 'art', textStreamingBudgetSec: 300, generatesArtifact: true })])
    ).toThrow(/art/);
  });

  it('accepts the shipped combinations', () => {
    expect(() =>
      assertBudgetConfig([
        scenario({ id: 'text' }),
        scenario({ id: 'text-budgeted', textStreamingBudgetSec: 300 }),
        scenario({ id: 'img', expectsImage: true }),
        scenario({ id: 'art', generatesArtifact: true }),
      ])
    ).not.toThrow();
  });

  it('checks every configured prompt, not just the ones a given day would pick', () => {
    const prompts = [scenario({ id: 'ok' }), scenario({ id: 'bad', textStreamingBudgetSec: 1, expectsImage: true })];
    expect(() => assertBudgetConfig(prompts)).toThrow(/bad/);
  });
});

describe('result builders', () => {
  it('rounds both duration fields at the same granularity', () => {
    // The completed and incomplete paths used to spell the same conversion two different ways.
    expect(msToSec(120_000)).toBe(120);
    expect(msToSec(120_499.6)).toBe(120.5);
    const done = completedResult(scenario(), { response: 'abcd', responseTimeMs: 2000, renderTimeMs: 500 });
    expect(done.responseTimeSec).toBe(msToSec(2000));
    expect(incompleteResult(scenario(), 2000).responseTimeSec).toBe(done.responseTimeSec);
  });

  it('classifies measuresDeliverable identically whether the prompt finished or not', () => {
    // Drift here would leak an abandoned artifact prompt into the text-only gated average.
    for (const over of [{ expectsImage: true }, { generatesArtifact: true }, {}]) {
      const s = scenario(over);
      const done = completedResult(s, { response: 'x', responseTimeMs: 1, renderTimeMs: 0 });
      expect(incompleteResult(s, 1).measuresDeliverable).toBe(done.measuresDeliverable);
    }
  });

  it('marks only the abandoned result incomplete, with no response text', () => {
    const abandoned = incompleteResult(scenario(), 300_000);
    expect(abandoned.incomplete).toBe(true);
    expect(abandoned.response).toBe('');
    expect(abandoned.responseRateCharsPerSec).toBe(0);
    expect(
      completedResult(scenario(), { response: 'x', responseTimeMs: 1000, renderTimeMs: 0 }).incomplete
    ).toBeUndefined();
  });

  it('does not divide by zero on an instant or empty response', () => {
    expect(
      completedResult(scenario(), { response: '', responseTimeMs: 1000, renderTimeMs: 0 }).responseRateCharsPerSec
    ).toBe(0);
    expect(
      completedResult(scenario(), { response: 'abc', responseTimeMs: 0, renderTimeMs: 0 }).responseRateCharsPerSec
    ).toBe(0);
  });
});

describe('mergeResults', () => {
  it('lets a retry supersede a stored incomplete for the same id', () => {
    // Playwright retries the prompt; the passing attempt must replace the abandoned one, or a
    // flaky-but-passing prompt would keep reporting its timeout.
    const abandoned = incompleteResult(scenario({ id: 'smartphone' }), 300_000);
    const passed = completedResult(scenario({ id: 'smartphone' }), {
      response: 'table',
      responseTimeMs: 90_000,
      renderTimeMs: 0,
    });
    const merged = mergeResults([abandoned], [passed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].incomplete).toBeUndefined();
    expect(merged[0].responseTimeSec).toBe(90);
  });

  it('keeps prompts with different ids side by side', () => {
    const a = completedResult(scenario({ id: 'a' }), { response: 'x', responseTimeMs: 1000, renderTimeMs: 0 });
    const b = incompleteResult(scenario({ id: 'b' }), 2000);
    expect(mergeResults([a], [b]).map(r => r.id)).toEqual(['a', 'b']);
  });
});

describe('gatedAverageSec', () => {
  const text = (id: string, sec: number): PromptResult =>
    completedResult(scenario({ id }), { response: 'x', responseTimeMs: sec * 1000, renderTimeMs: 0 });

  it('keeps an abandoned text prompt in the average', () => {
    // The 2026-09-18 cell: dropping the timed-out prompt reported 34.22s against a 150s budget.
    // The two kept timings and the 34.223 average are the numbers that run's artifact carried.
    const dropped = gatedAverageSec([text('reuters', 16.204), text('gpu', 52.241)]);
    expect(dropped).toBe(34.223);

    const kept = gatedAverageSec([
      text('reuters', 16.204),
      text('gpu', 52.241),
      incompleteResult(scenario({ id: 'smartphone' }), 300_000),
    ]);
    expect(kept).toBe(122.815);
    expect(kept).toBeGreaterThan(dropped);
  });

  it('excludes deliverable prompts whether they finished or were abandoned', () => {
    const withArtifact = gatedAverageSec([
      text('reuters', 10),
      incompleteResult(scenario({ id: 'storybook', generatesArtifact: true }), 466_000),
      completedResult(scenario({ id: 'taipei', generatesArtifact: true }), {
        response: 'x',
        responseTimeMs: 266_000,
        renderTimeMs: 0,
      }),
    ]);
    expect(withArtifact).toBe(10);
  });

  it('returns 0 when no gated prompt is present', () => {
    expect(gatedAverageSec([])).toBe(0);
    expect(gatedAverageSec([incompleteResult(scenario({ id: 'img', expectsImage: true }), 1000)])).toBe(0);
  });
});
