import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBudgetConfig,
  completedResult,
  gatedAverageSec,
  incompleteResult,
  isLatencyObservation,
  mergeResults,
  msToSec,
  StreamingTimeoutError,
  textStreamBudgetMs,
} from '../../../apps/client/e2e/ai-latency-budget';
import type { PromptScenario, PromptResult } from '../../../apps/client/e2e/ai-latency-helpers';

/**
 * Guard: the ai-latency suite's time budgets and result bookkeeping.
 *
 * Lives here rather than beside the module because `apps/client/e2e` is excluded from every
 * vitest project (apps/client/vitest.config.mts, LANE_EXCLUDE) - a co-located test would match no
 * project and never run, which is the same silent-no-op class this suite exists to catch. The
 * module under test stays importable outside a Playwright runner only as long as its imports stay
 * minimal, and nothing enforces that on its own: a `@playwright/test` import added there still
 * typechecks and still resolves under vitest. So the import list is asserted below, explicitly.
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

describe('module boundary', () => {
  const MODULE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../apps/client/e2e/ai-latency-budget.ts'
  );

  const FACTORY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../apps/client/e2e/ai-latency-suite-factory.ts'
  );

  it('records an incomplete result only behind the predicate', () => {
    // The predicate's unit tests below cannot see whether the factory still calls it, and the
    // factory itself is unreachable from any vitest project. Dropping the guard - recording every
    // throw again - is the exact run-1 revert, so the call site is pinned as text here.
    const source = fs.readFileSync(FACTORY, 'utf8');
    expect(source.match(/incompleteResult\(/g) ?? []).toHaveLength(1);
    const block = source.slice(source.indexOf('} catch (err'));
    expect(block).toMatch(/if \(isLatencyObservation\(err\)\) \{[\s\S]*?incompleteResult\(/);
    // ...and the throw is outside it, so a non-latency failure still fails the test.
    expect(block).toMatch(/\n\s+throw err;/);
  });

  it('imports nothing that would drag in a Playwright runner', () => {
    // The load-bearing property of this module: it is importable from here. `@playwright/test`
    // added to it would typecheck and would even resolve under vitest, so the only thing standing
    // between a stray import and this whole file quietly becoming unrunnable is this assertion.
    // Matched on `from '...'` rather than on a line-anchored `import ...` so a multi-line or
    // re-exported form cannot slip past the assertion.
    const source = fs.readFileSync(MODULE, 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(m => m[1]);
    expect([...new Set(specifiers)].sort()).toEqual(['./ai-latency-helpers', './constants']);
  });
});

describe('isLatencyObservation', () => {
  it('accepts a blown streaming budget', () => {
    expect(isLatencyObservation(new StreamingTimeoutError(150_000, 'reply still growing'))).toBe(true);
  });

  it('rejects the setup failures that share the same try block', () => {
    // These are the run-1 bug: recorded as incomplete, they counted into the gated average, paged
    // #slow-responses and failed the nightly for something that is not AI slowness.
    expect(isLatencyObservation(new Error('Send button did not become enabled after retries'))).toBe(false);
    expect(isLatencyObservation(new Error('locator.waitFor: Timeout 10000ms exceeded'))).toBe(false);
  });

  it('rejects a non-Error throw', () => {
    for (const thrown of [
      undefined,
      null,
      'Streaming did not complete within 150000ms',
      { name: 'StreamingTimeoutError' },
    ]) {
      expect(isLatencyObservation(thrown)).toBe(false);
    }
  });

  it('carries the cap and the stage in its message', () => {
    // The stage is the triage signal: no text streamed at all points at tool work, a growing reply
    // points at the stream itself.
    const err = new StreamingTimeoutError(300_000, 'no text streamed yet (tool work still in flight?)');
    expect(err.timeoutMs).toBe(300_000);
    expect(err.message).toContain('300000ms');
    expect(err.message).toContain('no text streamed yet');
  });
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

  it('rejects the pre-rename key instead of ignoring it', () => {
    // The specs cast their JSON config, so excess-property checking is off: a config left on the
    // old spelling would typecheck, read as configured, and silently fall back to the flat cap.
    const stale = { ...scenario({ id: 'smartphone' }), streamingBudgetSec: 300 } as PromptScenario;
    expect(() => assertBudgetConfig([stale])).toThrow(/streamingBudgetSec was renamed.*smartphone/s);
    expect(() => assertBudgetConfig([scenario({ id: 'ok', textStreamingBudgetSec: 300 })])).not.toThrow();
  });

  it('checks every configured prompt, not just the ones a given day would pick', () => {
    const prompts = [scenario({ id: 'ok' }), scenario({ id: 'bad', textStreamingBudgetSec: 1, expectsImage: true })];
    expect(() => assertBudgetConfig(prompts)).toThrow(/bad/);
  });
});

describe('result builders', () => {
  it('rounds every duration field to the nearest millisecond', () => {
    // Asserted against literals at a value where rounding and truncating disagree (1.235 vs 1.234).
    // Comparing a builder to msToSec would pass for either rule, which is what this used to do.
    expect(msToSec(120_000)).toBe(120);
    expect(msToSec(1234.6)).toBe(1.235);
    const done = completedResult(scenario(), { response: 'abcd', responseTimeMs: 1234.6, renderTimeMs: 1234.6 });
    expect(done.responseTimeSec).toBe(1.235);
    expect(done.renderTimeSec).toBe(1.235);
    expect(incompleteResult(scenario(), 1234.6).responseTimeSec).toBe(1.235);
  });

  it('reports the streaming rate over the measured window', () => {
    // Rounded to whole chars/s: the field is a triage signal, not a measurement.
    expect(
      completedResult(scenario(), { response: 'x'.repeat(10), responseTimeMs: 2000, renderTimeMs: 0 })
        .responseRateCharsPerSec
    ).toBe(5);
    expect(
      completedResult(scenario(), { response: 'abcd', responseTimeMs: 3000, renderTimeMs: 0 }).responseRateCharsPerSec
    ).toBe(1);
  });

  it('keeps renderTimeMs out of the streaming latency', () => {
    // The artifact/image settle tail is recorded beside the stream window, never folded into it.
    const done = completedResult(scenario(), { response: 'x', responseTimeMs: 2000, renderTimeMs: 90_000 });
    expect(done.responseTimeMs).toBe(2000);
    expect(done.renderTimeSec).toBe(90);
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
