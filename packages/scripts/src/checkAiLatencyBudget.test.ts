import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBudgetConfig,
  completedResult,
  describeStall,
  gatedMedianFirstTokenSec,
  gatedMedianSec,
  hasFirstAnswerText,
  incompleteResult,
  isLatencyObservation,
  isStreamComplete,
  latencyBreach,
  mergeResults,
  msToSec,
  StreamingTimeoutError,
  textStreamBudgetMs,
  TurnTimer,
  unexpectedArtifactIds,
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
 * results file - one that reports a healthy median for a cell that timed out.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHAT_PAGE = path.join(REPO, 'apps/client/e2e/pages/ChatPage.ts');
const PROMPT_REPLIES = path.join(REPO, 'apps/client/app/components/Session/PromptReplies.tsx');
const ARTIFACT_RENDERER = path.join(REPO, 'apps/client/app/components/Session/artifacts/ArtifactRenderer.tsx');
const readSource = (file: string) => fs.readFileSync(file, 'utf8');

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

  it('keeps each spec on one writer at a time', () => {
    // persistResults' unlocked read-modify-write is safe only while no two workers write the same
    // results file (see the invariants listed above persistResults). Breaking one still produces
    // well-formed results files, just with a row silently lost, so they are pinned as text here.
    // The one-project-per-spec invariant is not: playwright.config.ts's regex lists resist a text pin.
    const factory = fs.readFileSync(FACTORY, 'utf8');
    expect(factory.match(/describe\.configure\(\{[^}]*\}\)/g)).toEqual(["describe.configure({ mode: 'default' })"]);

    const e2eDir = path.dirname(FACTORY);
    const specs = fs.readdirSync(e2eDir).filter(f => /^ai-latency-.*\.spec\.ts$/.test(f));
    const filenames: string[] = [];
    for (const spec of specs) {
      const source = fs.readFileSync(path.join(e2eDir, spec), 'utf8');
      expect(source, spec).not.toMatch(/configure\(\s*\{[^}]*mode\s*:/);
      if (spec === 'ai-latency-discover.spec.ts') continue;
      const names = [...source.matchAll(/resultsFilename:\s*'([^']+)'/g)].map(m => m[1]);
      expect(names, spec).toHaveLength(1);
      filenames.push(...names);
    }
    expect(filenames.length).toBeGreaterThan(0);
    expect(new Set(filenames).size).toBe(filenames.length);

    // Each repeat gets its own worker hash, so it runs as a separate job writing the same file.
    const workflow = fs.readFileSync(path.resolve(e2eDir, '../../../.github/workflows/e2e-ai-latency.yml'), 'utf8');
    expect(workflow).not.toMatch(/repeat-each/);
    const config = fs.readFileSync(path.resolve(e2eDir, '../playwright.config.ts'), 'utf8');
    expect(config).not.toMatch(/repeatEach/);
  });

  it('keeps the latency gate title in sync with the workflow Quality filter', () => {
    // The workflow excludes the gate from the Quality column by title; a rename on one side only
    // would turn every slow-but-correct cell into a quality failure.
    const factory = fs.readFileSync(FACTORY, 'utf8');
    const title = factory.match(/const LATENCY_GATE_TITLE = '([^']+)'/)?.[1];
    expect(title).toBeTruthy();
    const workflow = fs.readFileSync(
      path.resolve(path.dirname(FACTORY), '../../../.github/workflows/e2e-ai-latency.yml'),
      'utf8'
    );
    expect(workflow).toContain(`--arg gate '${title}'`);
  });

  it('times every prompt from send, not from before typing', () => {
    // The factory and ChatPage both import Playwright, so the wiring is pinned as text: the clock
    // is a TurnTimer handed to both send helpers, and each helper marks it right after Enter.
    const factory = fs.readFileSync(FACTORY, 'utf8');
    expect(factory).toContain('new TurnTimer()');
    expect(factory).not.toMatch(/startMs/);
    expect(factory).toMatch(/sendImageMessageAndWaitForResponse\([^)]*, timer\)/);
    expect(factory).toMatch(/sendMessageAndWaitForResponse\([^)]*, timer\)/);
    const chatPage = fs.readFileSync(CHAT_PAGE, 'utf8');
    expect(chatPage.match(/keyboard\.press\('Enter'\);\n\s+timer\?\.markSent\(\);/g) ?? []).toHaveLength(2);
    expect(chatPage.match(/timer\?\.markSent\(/g) ?? []).toHaveLength(2);
  });

  it('records the attempt and the first token on every result', () => {
    const factory = fs.readFileSync(FACTORY, 'utf8');
    expect(factory).toContain('const attempt = test.info().retry;');
    expect(factory.match(/firstTokenMs: timer\.firstTokenMs\(\)/g) ?? []).toHaveLength(2);
    expect(factory.match(/\battempt,\n/g) ?? []).toHaveLength(2);
  });

  it('draws enough prompts per cell for the median to mean something', () => {
    const factory = fs.readFileSync(FACTORY, 'utf8');
    const perCell = Number(factory.match(/const PROMPTS_PER_CELL = (\d+);/)?.[1]);
    expect(perCell).toBeGreaterThanOrEqual(5);
    expect(factory).toContain('pickDeterministic(prompts, PROMPTS_PER_CELL, dailySeed)');
    // One test per drawn prompt; a hard-coded count would drop or duplicate prompts.
    expect(factory).toContain('i < selectedPrompts.length');
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
  it('records the attempt (0 unless given) and the first token only when it was seen', () => {
    const first = completedResult(scenario(), { response: 'x', responseTimeMs: 5000, renderTimeMs: 0 });
    expect(first.attempt).toBe(0);
    expect('firstTokenMs' in first).toBe(false);
    expect('firstTokenSec' in first).toBe(false);

    const retry = completedResult(scenario(), {
      response: 'x',
      responseTimeMs: 5000,
      renderTimeMs: 0,
      attempt: 2,
      firstTokenMs: 1234.6,
    });
    expect(retry.attempt).toBe(2);
    expect(retry.firstTokenMs).toBe(1234.6);
    expect(retry.firstTokenSec).toBe(1.235);

    const abandoned = incompleteResult(scenario(), 9000, { attempt: 1, firstTokenMs: 800 });
    expect(abandoned.attempt).toBe(1);
    expect(abandoned.firstTokenSec).toBe(0.8);
  });

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
    // Drift here would leak an abandoned artifact prompt into the text-only gated median.
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
  const attempt = (id: string, n: number, sec: number) =>
    completedResult(scenario({ id }), { response: 'x', responseTimeMs: sec * 1000, renderTimeMs: 0, attempt: n });

  it('keeps an abandoned attempt beside the retry that passed, marked retried', () => {
    // Last-write-wins used to drop the first attempt, so the slow run that caused the retry never
    // reached the gate.
    const abandoned = incompleteResult(scenario({ id: 'smartphone' }), 300_000);
    const passed = attempt('smartphone', 1, 90);
    const merged = mergeResults([abandoned], [passed]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ attempt: 0, incomplete: true, retried: true, responseTimeSec: 300 });
    expect(merged[1]).toMatchObject({ attempt: 1, responseTimeSec: 90 });
    expect(merged[1].retried).toBeUndefined();
  });

  it('keeps a slow completed attempt that was retried for another reason', () => {
    // A keyword miss fails the test and retries it; the first attempt's timing is still real.
    const merged = mergeResults([attempt('gpu', 0, 40)], [attempt('gpu', 1, 8)]);
    expect(merged.map(r => [r.responseTimeSec, r.retried])).toEqual([
      [40, true],
      [8, undefined],
    ]);
  });

  it('replaces a rewrite of the same attempt instead of duplicating it', () => {
    // afterAll re-persists the worker's in-memory results over the per-prompt writes.
    const merged = mergeResults([attempt('a', 0, 5)], [attempt('a', 0, 5)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].retried).toBeUndefined();
  });

  it('marks retried by attempt number, whichever side the later attempt arrives on', () => {
    const merged = mergeResults([attempt('a', 1, 3)], [attempt('a', 0, 9)]);
    expect(merged.find(r => r.attempt === 0)?.retried).toBe(true);
    expect(merged.find(r => r.attempt === 1)?.retried).toBeUndefined();
  });

  it('reads a row written before attempts were recorded as attempt 0', () => {
    const { attempt: _omitted, ...legacy } = attempt('a', 0, 9);
    const merged = mergeResults([legacy as PromptResult], [attempt('a', 1, 3)]);
    expect(merged).toHaveLength(2);
    expect(merged[0].retried).toBe(true);
  });

  it('keeps prompts with different ids side by side', () => {
    const a = completedResult(scenario({ id: 'a' }), { response: 'x', responseTimeMs: 1000, renderTimeMs: 0 });
    const b = incompleteResult(scenario({ id: 'b' }), 2000);
    expect(mergeResults([a], [b]).map(r => r.id)).toEqual(['a', 'b']);
  });
});

describe('gatedMedianSec', () => {
  const text = (id: string, sec: number): PromptResult =>
    completedResult(scenario({ id }), { response: 'x', responseTimeMs: sec * 1000, renderTimeMs: 0 });

  it('takes the middle value of an odd count and the midpoint of an even one', () => {
    expect(gatedMedianSec([text('a', 3), text('b', 10), text('c', 4)])).toBe(4);
    expect(gatedMedianSec([text('a', 2), text('b', 4), text('c', 6), text('d', 100)])).toBe(5);
  });

  it('does not let one slow prompt swing the cell', () => {
    // The mean of these is 44.4s; one spike decided the old gate on its own.
    expect(gatedMedianSec([text('a', 4), text('b', 5), text('c', 6), text('d', 7), text('e', 200)])).toBe(6);
  });

  it('keeps an abandoned text prompt in the statistic', () => {
    const kept = gatedMedianSec([
      text('reuters', 16.204),
      text('gpu', 52.241),
      incompleteResult(scenario({ id: 'smartphone' }), 300_000),
    ]);
    expect(kept).toBe(52.241);
  });

  it('judges a retried prompt on its slowest attempt, as one data point', () => {
    // The slow attempt that caused the retry still reaches the gate (last-write-wins dropped it)...
    const retried = mergeResults(
      [text('a', 4), text('b', 5), text('c', 60)],
      [completedResult(scenario({ id: 'c' }), { response: 'x', responseTimeMs: 6000, renderTimeMs: 0, attempt: 1 })]
    );
    expect(retried).toHaveLength(4);
    expect(gatedMedianSec([text('a', 30), text('b', 40), ...retried.filter(r => r.id === 'c')])).toBe(40);

    // ...but its attempts are one prompt, so a flaky prompt cannot outvote the others. Counted per
    // attempt, [10, 12, 50, 120, 120] would put the median at 50.
    const flaky = mergeResults(
      [text('a', 10), text('b', 12), incompleteResult(scenario({ id: 'c' }), 120_000)],
      [
        incompleteResult(scenario({ id: 'c' }), 120_000, { attempt: 1 }),
        completedResult(scenario({ id: 'c' }), { response: 'x', responseTimeMs: 50_000, renderTimeMs: 0, attempt: 2 }),
      ]
    );
    expect(flaky).toHaveLength(5);
    expect(gatedMedianSec(flaky)).toBe(12);
  });

  it('excludes deliverable prompts whether they finished or were abandoned', () => {
    const withArtifact = gatedMedianSec([
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
    expect(gatedMedianSec([])).toBe(0);
    expect(gatedMedianSec([incompleteResult(scenario({ id: 'img', expectsImage: true }), 1000)])).toBe(0);
  });
});

describe('gatedMedianFirstTokenSec', () => {
  const withFirstToken = (id: string, firstTokenMs?: number, over: Partial<PromptScenario> = {}) =>
    completedResult(scenario({ id, ...over }), {
      response: 'x',
      responseTimeMs: 20_000,
      renderTimeMs: 0,
      firstTokenMs,
    });

  it('takes the median over the gated prompts that saw an answer token', () => {
    expect(
      gatedMedianFirstTokenSec([withFirstToken('a', 1000), withFirstToken('b', 3000), withFirstToken('c', 2000)])
    ).toBe(2);
  });

  it('takes one value per prompt, its slowest attempt', () => {
    const results = mergeResults(
      [withFirstToken('a', 1000), withFirstToken('b', 2000), withFirstToken('c', 9000)],
      [
        { ...withFirstToken('c', 500), attempt: 1 },
        { ...withFirstToken('c', 400), attempt: 2 },
      ]
    );
    expect(gatedMedianFirstTokenSec(results)).toBe(2);
  });

  it('counts an attempt abandoned before its first token at its elapsed time', () => {
    const results = [
      withFirstToken('a', 1000),
      withFirstToken('b', 2000),
      incompleteResult(scenario({ id: 'c' }), 120_000),
      incompleteResult(scenario({ id: 'd' }), 120_000),
    ];
    expect(gatedMedianFirstTokenSec(results)).toBe(61);
  });

  it('skips prompts with no first token and deliverable prompts', () => {
    expect(
      gatedMedianFirstTokenSec([
        withFirstToken('a', 1500),
        withFirstToken('b'),
        withFirstToken('img', 90_000, { expectsImage: true }),
      ])
    ).toBe(1.5);
  });

  it('returns 0 when no gated prompt saw an answer token', () => {
    expect(gatedMedianFirstTokenSec([withFirstToken('a')])).toBe(0);
    expect(gatedMedianFirstTokenSec([])).toBe(0);
  });
});

describe('latencyBreach', () => {
  const text = (id: string, sec: number): PromptResult =>
    completedResult(scenario({ id }), { response: 'x', responseTimeMs: sec * 1000, renderTimeMs: 0 });

  it('passes a cell whose median is at or under the threshold', () => {
    expect(latencyBreach([text('a', 5), text('b', 15)], 10)).toBeNull();
  });

  it('passes a cell where one spike sits among fast prompts', () => {
    expect(latencyBreach([text('a', 1), text('b', 2), text('c', 3), text('d', 4), text('e', 200)], 10)).toBeNull();
  });

  it('fails a cell whose median exceeds the threshold, even if one prompt was fast', () => {
    const breach = latencyBreach([text('a', 2), text('b', 30)], 10);
    expect(breach).toContain('median AI latency 16s exceeds the 10s threshold');
    expect(breach).toContain('a=2s');
  });

  it('fails on an abandoned prompt even when the median stays under the threshold', () => {
    const breach = latencyBreach([text('a', 1), text('b', 1), incompleteResult(scenario({ id: 'c' }), 5000)], 10);
    expect(breach).toContain('1 prompt(s) never finished: c');
    expect(breach).not.toContain('exceeds');
  });

  it('reports both causes when the median is over and a prompt never finished', () => {
    expect(latencyBreach([text('a', 30), incompleteResult(scenario({ id: 'c' }), 5000)], 10)).toBe(
      'Latency breach - median AI latency 17.5s exceeds the 10s threshold; 1 prompt(s) never finished: c [a=30s, c=5s (incomplete)]'
    );
  });

  it('does not fail on an abandoned attempt that a retry completed, but keeps it in the median', () => {
    const results = mergeResults(
      [text('a', 1), text('b', 2), incompleteResult(scenario({ id: 'c' }), 50_000)],
      [completedResult(scenario({ id: 'c' }), { response: 'x', responseTimeMs: 3000, renderTimeMs: 0, attempt: 1 })]
    );
    expect(latencyBreach(results, 10)).toBeNull();
    // Per prompt [1, 2, 50]: c is judged on its abandoned attempt, and the breach lists every attempt.
    expect(latencyBreach(results, 1.5)).toBe(
      'Latency breach - median AI latency 2s exceeds the 1.5s threshold [a=1s, b=2s, c=50s (incomplete, retried), c=3s]'
    );
  });

  it('fails when the latest attempt was abandoned too', () => {
    const results = mergeResults(
      [text('a', 1), incompleteResult(scenario({ id: 'c' }), 50_000)],
      [incompleteResult(scenario({ id: 'c' }), 50_000, { attempt: 1 })]
    );
    expect(latencyBreach(results, 100)).toContain('1 prompt(s) never finished: c');
  });

  it('ignores deliverable prompts and reports no breach when nothing is gated', () => {
    const slowImage = completedResult(scenario({ id: 'img', expectsImage: true }), {
      response: '',
      responseTimeMs: 600_000,
      renderTimeMs: 0,
    });
    expect(latencyBreach([text('a', 5), slowImage], 10)).toBeNull();
    expect(
      latencyBreach([text('a', 1), incompleteResult(scenario({ id: 'img', expectsImage: true }), 5000)], 10)
    ).toBeNull();
    expect(latencyBreach([slowImage], 10)).toBeNull();
    expect(latencyBreach([], 10)).toBeNull();
  });
});

describe('TurnTimer', () => {
  it('times from send and reports the first answer text relative to it', () => {
    const timer = new TurnTimer();
    timer.markSent(1000);
    timer.markFirstText(1800);
    timer.markFirstText(2500);
    expect(timer.firstTokenMs()).toBe(800);
    expect(timer.elapsedSinceSendMs(4000)).toBe(3000);
  });

  it('refuses to report a timing for a turn that was never sent', () => {
    const timer = new TurnTimer();
    timer.markFirstText(500);
    expect(timer.firstTokenMs()).toBeUndefined();
    expect(() => timer.elapsedSinceSendMs(1000)).toThrow(/before the message was sent/);
  });

  it('reports no first token when no answer text was seen', () => {
    const timer = new TurnTimer();
    timer.markSent(1000);
    expect(timer.firstTokenMs()).toBeUndefined();
  });

  it('keeps the first send time across a resend but forgets the failed attempt text', () => {
    // The "request timed out" resend: the user waited through both attempts, and the first
    // attempt's text was the error, not an answer token.
    const timer = new TurnTimer();
    timer.markSent(1000);
    timer.markFirstText(1500);
    timer.markSent(9000);
    expect(timer.firstTokenMs()).toBeUndefined();
    timer.markFirstText(9700);
    expect(timer.firstTokenMs()).toBe(8700);
    expect(timer.elapsedSinceSendMs(12_000)).toBe(11_000);
  });
});

describe('hasFirstAnswerText', () => {
  it('fires on answer text that was not there before send', () => {
    expect(hasFirstAnswerText('Paris', '')).toBe(true);
    expect(hasFirstAnswerText('Paris', 'an earlier answer')).toBe(true);
  });

  it('ignores an empty or whitespace answer and the prior turn left in place', () => {
    expect(hasFirstAnswerText('', '')).toBe(false);
    expect(hasFirstAnswerText('  \n', '')).toBe(false);
    expect(hasFirstAnswerText('an earlier answer', 'an earlier answer')).toBe(false);
  });
});

describe('isStreamComplete', () => {
  const PREVIOUS = 'Brazil, Argentina';
  // A bare list renders <ol><li> with no markdown <p>, so it carries no `ai-response` test id.
  // Reading only that id saw '' here, and the old wait sat out its whole budget (~152s) on a
  // reply that had already arrived.
  const LIST_ONLY_REPLY = 'Mercury\nVenus\nEarth\nMars\nJupiter';

  it('completes a list-only reply whose stop button flashed by unseen', () => {
    expect(isStreamComplete({ stopVisible: false, text: LIST_ONLY_REPLY }, PREVIOUS, false)).toBe(true);
  });

  it('completes once a seen stop button hides, even with no new text (image-only reply)', () => {
    expect(isStreamComplete({ stopVisible: false, text: PREVIOUS }, PREVIOUS, true)).toBe(true);
  });

  it('never completes while the stop button is visible, however stable the text', () => {
    expect(isStreamComplete({ stopVisible: true, text: LIST_ONLY_REPLY }, PREVIOUS, true)).toBe(false);
  });

  it('does not mistake the prior turn for this one before anything streamed', () => {
    expect(isStreamComplete({ stopVisible: false, text: PREVIOUS }, PREVIOUS, false)).toBe(false);
    expect(isStreamComplete({ stopVisible: false, text: '' }, '', false)).toBe(false);
    expect(isStreamComplete({ stopVisible: false, text: '' }, PREVIOUS, false)).toBe(false);
  });

  it('completes once a seen stop button hides, even if no reply text was read', () => {
    expect(isStreamComplete({ stopVisible: false, text: '' }, PREVIOUS, true)).toBe(true);
  });
});

describe('describeStall', () => {
  it('names the stage the wait ran out in', () => {
    expect(describeStall({ stopVisible: true, text: '' })).toMatch(/no text streamed/);
    expect(describeStall({ stopVisible: true, text: 'partial' })).toMatch(/stop button never hid/);
    expect(describeStall({ stopVisible: false, text: '' })).toMatch(/never appeared/);
    expect(describeStall({ stopVisible: false, text: 'Brazil, Argentina' })).toMatch(/never appeared/);
  });
});

describe('ChatPage reply reader', () => {
  it('reads replies from the body inside the root container, never the <p>-only ai-response id', () => {
    // ChatPage imports Playwright, so no vitest project can load it; the selector is pinned as
    // text. Reverting to `ai-response` brings back the list-only-reply stall above.
    const source = fs.readFileSync(CHAT_PAGE, 'utf8');
    // Strip comment lines: the doc comment names both ids, so it must satisfy neither half.
    const code = source
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/getByTestId\(\s*['"`]ai-response['"`]/);
    expect(code).not.toMatch(/data-testid=['"]?ai-response['"\]]/);
    expect(code).toMatch(/getByTestId\(\s*['"`]ai-response-body['"`]/);
    expect(code).toMatch(/isStreamComplete\(/);
    // The reader falls back to the whole root when the body id is absent, so renaming the test id
    // would silently put reasoning text back into the returned string.
    expect(fs.readFileSync(PROMPT_REPLIES, 'utf8')).toMatch(/data-testid="ai-response-body"/);
  });

  it('reads the first token from the markdown answer, which reasoning and status chrome never enter', () => {
    // The root shows "Thinking..." and reasoning before any answer token, so reading it would time
    // the first token at the status line. The id is pinned on both sides.
    expect(readSource(CHAT_PAGE)).toContain("getByTestId('ai-response-markdown')");
    expect(readSource(PROMPT_REPLIES)).toContain('<div className="b4m-md" data-testid="ai-response-markdown">');
  });
});

describe('unexpected artifact on a chat prompt', () => {
  const chat = (id: string, sec: number, artifactRendered = false): PromptResult =>
    completedResult(scenario({ id }), { response: 'x', responseTimeMs: sec * 1000, renderTimeMs: 0, artifactRendered });

  it('marks an unflagged prompt that rendered an artifact as a deliverable and flags it', () => {
    const result = chat('gpu', 70, true);
    expect(result.measuresDeliverable).toBe(true);
    expect(result.unexpectedArtifact).toBe(true);
  });

  it('leaves a chat-mode reply and the flagged-artifact behaviour unchanged', () => {
    const plain = chat('reuters', 20);
    expect(plain.measuresDeliverable).toBe(false);
    expect(plain.unexpectedArtifact).toBeUndefined();

    // A prompt that declares generatesArtifact is expected to render one: deliverable, not "unexpected".
    const flagged = completedResult(scenario({ id: 'storybook', generatesArtifact: true }), {
      response: 'x',
      responseTimeMs: 1000,
      renderTimeMs: 0,
      artifactRendered: true,
    });
    expect(flagged.measuresDeliverable).toBe(true);
    expect(flagged.unexpectedArtifact).toBeUndefined();
  });

  it('drops the artifact-mode result from the gated median and the breach check', () => {
    const results = [chat('reuters', 20), chat('smartphone', 30), chat('gpu', 70, true)];
    expect(gatedMedianSec(results)).toBe(25);
    expect(latencyBreach(results, 26)).toBeNull();
    // Without the exclusion the median (30s) would have breached the same threshold.
    expect(latencyBreach([chat('reuters', 20), chat('smartphone', 30), chat('gpu', 70)], 26)).toContain(
      'median AI latency 30s'
    );
  });

  it('reads as No Data (median 0, no breach) when every gated prompt switched to an artifact', () => {
    const results = [chat('gpu', 70, true), chat('reuters', 65, true)];
    expect(gatedMedianSec(results)).toBe(0);
    expect(latencyBreach(results, 30)).toBeNull();
    expect(results.every(r => r.measuresDeliverable)).toBe(true);
  });

  it('lists the switched prompts so the summary can report them', () => {
    expect(unexpectedArtifactIds([chat('a', 1), chat('gpu', 70, true), chat('b', 2, true)])).toEqual(['gpu', 'b']);
    expect(unexpectedArtifactIds([chat('a', 1)])).toEqual([]);
    // A retried prompt that switched on both attempts is one prompt, not two.
    expect(
      unexpectedArtifactIds(mergeResults([chat('gpu', 70, true)], [{ ...chat('gpu', 60, true), attempt: 1 }]))
    ).toEqual(['gpu']);
    // A switched attempt whose retry answered in chat is in the median, so it is not listed.
    expect(unexpectedArtifactIds(mergeResults([chat('gpu', 70, true)], [{ ...chat('gpu', 6), attempt: 1 }]))).toEqual(
      []
    );
  });

  it('keeps an abandoned chat prompt gated, since an artifact cannot be told from a hang', () => {
    const results = [chat('a', 1), incompleteResult(scenario({ id: 'gpu' }), 300_000)];
    expect(latencyBreach(results, 30)).toContain('never finished: gpu');
  });
});

describe('ChatPage artifact detector', () => {
  it('keys on the html/react renderers, so a promoted python or mermaid fence stays a chat reply', () => {
    // ChatPage imports Playwright, so no vitest project can load it; the wiring is pinned as text.
    // The server promotes python/mermaid/recharts code fences into artifact cards after the
    // stream, so matching any artifact-renderer-* would drop ordinary chat replies from the gate.
    const chatPage = readSource(CHAT_PAGE);
    expect(chatPage).toContain('[data-testid="artifact-renderer-html"]');
    expect(chatPage).toContain('[data-testid="artifact-renderer-react"]');
    expect(chatPage).not.toContain('[data-testid^="artifact-renderer-"]');
    expect(chatPage).not.toContain('data-artifact-tag');
  });

  it('pins the placeholder test ids against the components that mount them', () => {
    expect(readSource(ARTIFACT_RENDERER)).toContain('data-testid={`artifact-renderer-${artifact.type}`}');
    expect(readSource(CHAT_PAGE)).toContain("getByTestId('generating-artifact-indicator')");
    expect(readSource(PROMPT_REPLIES)).toContain('data-testid="generating-artifact-indicator"');
    expect(readSource(ARTIFACT_RENDERER)).toContain('data-testid="artifact-loading"');
  });
});
