import { TIMEOUTS } from './constants';
import type { PromptScenario, PromptResult } from './ai-latency-helpers';

// The ai-latency suite's time budgets and result bookkeeping, plus the error type that decides
// which failures count as a latency observation. Kept apart from ai-latency-suite-factory.ts and
// pages/ChatPage.ts, both of which import Playwright and so load only under a Playwright runner:
// this module imports nothing beyond ./constants and a type, which is what lets
// packages/scripts/src/checkAiLatencyBudget.test.ts import it under vitest and pin these rules.
// `e2e` is excluded from every vitest project (apps/client/vitest.config.mts, LANE_EXCLUDE), so a
// co-located test here would match no project and never run.
// Nothing enforces that restraint on its own - a `@playwright/test` import added here would still
// typecheck and still resolve - so the guard asserts this file's import list directly.

/**
 * The streaming wait exhausted its budget: the reply was still unfinished when the cap expired.
 *
 * Thrown by ChatPage.waitForStreamingComplete and declared here, away from Playwright, so the
 * suite's guard can be tested. A distinct type because only this failure is a latency measurement.
 */
export class StreamingTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    stage: string
  ) {
    super(`Streaming did not complete within ${timeoutMs}ms - ${stage}`);
    this.name = 'StreamingTimeoutError';
  }
}

/**
 * Whether a failure is something to record as a latency data point.
 *
 * Only a blown streaming budget is. The send path also does pre-stream setup - waiting for the send
 * button to enable, gating on the response container mounting - and stamping one of those flakes
 * `incomplete` would count it into the gated average, page the slow-responses channel and fail the
 * nightly for something that is not AI slowness. Everything else must propagate untouched: the test
 * still fails loudly, it just does not claim a timing it never took.
 */
export function isLatencyObservation(err: unknown): err is StreamingTimeoutError {
  return err instanceof StreamingTimeoutError;
}

/** ms -> s at 1 ms granularity. One helper so every duration field rounds the same way. */
export function msToSec(ms: number): number {
  return Math.round(ms) / 1000;
}

/**
 * Per-response streaming cap for a text prompt.
 *
 * Never tighter than the latency budget the suite declares: capping at AI_RESPONSE while
 * thresholdSec allows more fails a response the suite would have accepted, and reports it as a
 * hang instead of as slow. A scenario whose first token trails minutes of tool work overrides
 * that with its own budget.
 *
 * Image/artifact prompts do NOT come through here - they always take TIMEOUTS.IMAGE_GENERATION,
 * because their deliverable is generated around the stream rather than after it.
 */
export function textStreamBudgetMs(thresholdSec: number, scenario: PromptScenario): number {
  return Math.max(TIMEOUTS.AI_RESPONSE, (scenario.textStreamingBudgetSec ?? thresholdSec) * 1000);
}

/** Pre-rename spelling of textStreamingBudgetSec. */
const LEGACY_BUDGET_KEY = 'streamingBudgetSec';

/**
 * Rejects a budget that would never be read: the pre-rename key, and a budget on a prompt whose
 * branch cannot reach it.
 *
 * Deliberately checked over the WHOLE prompt list at suite construction rather than inside
 * textStreamBudgetMs: that function is only reached on the text branch, so an image/artifact prompt
 * carrying a budget would never pass through it and the misconfiguration would stay invisible.
 * Covers every configured prompt, not just the three the daily seed picked, so a bad entry surfaces
 * on the first run rather than on the day it is drawn.
 */
export function assertBudgetConfig(prompts: PromptScenario[]): void {
  // The specs load their JSON config and cast it (`config.prompts as PromptScenario[]`), which
  // turns off excess-property checking - so the pre-rename spelling would sit in a config file
  // typechecking cleanly while nothing read it, silently dropping a hand-picked budget back to
  // max(AI_RESPONSE, thresholdSec). That is the failure mode this whole module exists to catch.
  const legacy = prompts.filter(p => LEGACY_BUDGET_KEY in p);
  if (legacy.length > 0) {
    throw new Error(
      `${LEGACY_BUDGET_KEY} was renamed to textStreamingBudgetSec and is no longer read. ` +
        `Rename it on: ${legacy.map(p => p.id).join(', ')}.`
    );
  }

  const misconfigured = prompts.filter(
    p => p.textStreamingBudgetSec !== undefined && (p.expectsImage || p.generatesArtifact)
  );
  if (misconfigured.length > 0) {
    throw new Error(
      `textStreamingBudgetSec is ignored for image/artifact prompts (they always take ` +
        `TIMEOUTS.IMAGE_GENERATION), but it is set on: ${misconfigured.map(p => p.id).join(', ')}.`
    );
  }
}

/**
 * Fields a result carries identically whether the prompt finished or was abandoned. Shared so
 * measuresDeliverable cannot drift between the two paths - an abandoned artifact prompt must be
 * classified exactly like a completed one, or it would leak into the gated average.
 */
function baseResult(scenario: PromptScenario) {
  return {
    id: scenario.id,
    prompt: scenario.prompt,
    measuresDeliverable: Boolean(scenario.expectsImage || scenario.generatesArtifact),
  };
}

export function completedResult(
  scenario: PromptScenario,
  args: { response: string; responseTimeMs: number; renderTimeMs: number }
): PromptResult {
  const responseTimeSec = msToSec(args.responseTimeMs);
  return {
    ...baseResult(scenario),
    response: args.response,
    responseTimeMs: args.responseTimeMs,
    responseTimeSec,
    responseRateCharsPerSec:
      args.response.length > 0 && responseTimeSec > 0 ? Math.round(args.response.length / responseTimeSec) : 0,
    renderTimeMs: args.renderTimeMs,
    renderTimeSec: msToSec(args.renderTimeMs),
  };
}

/**
 * Stand-in for a prompt that never finished. responseTimeSec is the elapsed time at the point it
 * was abandoned, so it understates the real latency - but it keeps the prompt inside the gated
 * average instead of dropping it, which is what let a cell whose worst prompt timed out still
 * average well under thresholdSec.
 */
export function incompleteResult(scenario: PromptScenario, elapsedMs: number): PromptResult {
  return {
    ...baseResult(scenario),
    response: '',
    responseTimeMs: elapsedMs,
    responseTimeSec: msToSec(elapsedMs),
    responseRateCharsPerSec: 0,
    renderTimeMs: 0,
    renderTimeSec: 0,
    incomplete: true,
  };
}

/** Last write per id wins, so a retry's result supersedes the original attempt's. */
export function mergeResults(prior: PromptResult[], next: PromptResult[]): PromptResult[] {
  return [...new Map([...prior, ...next].map(r => [r.id, r])).values()];
}

/**
 * The gated latency average must stay text-streaming-only. Image/artifact prompts measure a much
 * longer, different thing (deliverable generation, which for artifacts runs during the stream), so
 * only text prompts fold in - otherwise the workflow's AVG > thresholdSec check would go red on
 * generation time and mask real streaming regressions.
 */
export function gatedAverageSec(results: PromptResult[]): number {
  const gated = results.filter(r => !r.measuresDeliverable);
  if (gated.length === 0) return 0;
  return Math.round((gated.reduce((sum, r) => sum + r.responseTimeSec, 0) / gated.length) * 1000) / 1000;
}
