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
 * `incomplete` would count it into the gated median, page the slow-responses channel and fail the
 * nightly for something that is not AI slowness. Everything else must propagate untouched: the test
 * still fails loudly, it just does not claim a timing it never took.
 */
export function isLatencyObservation(err: unknown): err is StreamingTimeoutError {
  return err instanceof StreamingTimeoutError;
}

/** One poll of the chat UI while waiting for a reply to finish. */
export type StreamSnapshot = {
  stopVisible: boolean;
  /** innerText of the newest reply's body (root container when no body is mounted); '' when none. */
  text: string;
};

/**
 * Whether the turn just sent has finished, given the latest poll.
 *
 * Done means the stop button is gone AND this turn demonstrably happened: either the stop button
 * was seen at some point (it can flash by too fast to catch on a short reply) or the newest reply
 * differs from the pre-send baseline. A stop button that never hides is never done - the caller
 * fails it as a StreamingTimeoutError instead of guessing from stable text. One recovery is not
 * distinguishable here: if the app gives up on a stalled turn itself it marks it complete and
 * hides the button, which looks like a finished reply. That still fails the latency budget on
 * time, but it is recorded as a slow success, not as incomplete.
 */
export function isStreamComplete(snapshot: StreamSnapshot, previousResponse: string, sawStopButton: boolean): boolean {
  if (snapshot.stopVisible) return false;
  if (sawStopButton) return true;
  // Safe only on the plain chat path, where the stop button shows optimistically on send
  // (OPTIMISTIC_GENERATING_STATUS in useSendMessage, read by app/hooks/chatCompletionState.ts).
  // Slash commands and agent_executor skip it, and mid-stream chrome has text too.
  return snapshot.text !== '' && snapshot.text !== previousResponse;
}

/**
 * Whether this turn's first answer token is on the page, given the newest reply's markdown answer
 * text (`ai-response-markdown`) now and before send. Read from the markdown element, never the body
 * or root: the root shows "Thinking..." and reasoning before any answer token arrives, and the body
 * can mount for media or a notice alone. In a resumed chat the baseline is the prior reply, so a late
 * re-render of it (citations, an artifact card settling) would mark a false-early first token.
 */
export function hasFirstAnswerText(answerText: string, previousAnswerText: string): boolean {
  return answerText.trim() !== '' && answerText !== previousAnswerText;
}

/** Why a streaming wait ran out, for the StreamingTimeoutError message. */
export function describeStall(snapshot: StreamSnapshot): string {
  if (!snapshot.stopVisible) return 'no new reply and the stop button never appeared';
  // An empty reply means the turn never reached token output; a non-empty one means the stream
  // (or its completion signal) stalled. Different fixes, so say which.
  return snapshot.text === ''
    ? 'no text streamed yet (tool work still in flight?)'
    : 'reply streamed but stop button never hid';
}

/** ms -> s at 1 ms granularity. One helper so every duration field rounds the same way. */
export function msToSec(ms: number): number {
  return Math.round(ms) / 1000;
}

/**
 * Clock for one chat turn, written by the ChatPage send helpers and read by the suite.
 *
 * The turn starts at Enter, not before typing: typing time is harness work, not AI latency. A
 * recorder rather than a return value because the suite also needs the send time when the send
 * helper throws a StreamingTimeoutError. The send helper's own "request timed out" resend keeps
 * the first send time - the user waited through the failed attempt - but drops that attempt's
 * first text, which was the error, not an answer. That rare resend re-types the prompt inside the
 * timed window; the harness does not subtract it.
 */
export class TurnTimer {
  private sentAtMs?: number;
  private firstTextAtMs?: number;

  markSent(atMs: number = Date.now()): void {
    this.sentAtMs ??= atMs;
    this.firstTextAtMs = undefined;
  }

  /** First poll that saw this turn's reply text; later calls are ignored. */
  markFirstText(atMs: number = Date.now()): void {
    if (this.sentAtMs !== undefined) this.firstTextAtMs ??= atMs;
  }

  /** ms from send to `atMs`. Throws if the turn was never sent - there is no timing to report. */
  elapsedSinceSendMs(atMs: number = Date.now()): number {
    if (this.sentAtMs === undefined) throw new Error('TurnTimer read before the message was sent');
    return atMs - this.sentAtMs;
  }

  /** ms from send to the first reply text, or undefined when no text was seen (e.g. image-only). */
  firstTokenMs(): number | undefined {
    if (this.sentAtMs === undefined || this.firstTextAtMs === undefined) return undefined;
    return this.firstTextAtMs - this.sentAtMs;
  }
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
 * Covers every configured prompt, not just the ones the daily seed picked, so a bad entry surfaces
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
 * classified exactly like a completed one, or it would leak into the gated median.
 */
function baseResult(scenario: PromptScenario, attempt: number, firstTokenMs: number | undefined) {
  return {
    id: scenario.id,
    prompt: scenario.prompt,
    attempt,
    measuresDeliverable: Boolean(scenario.expectsImage || scenario.generatesArtifact),
    ...(firstTokenMs !== undefined && { firstTokenMs, firstTokenSec: msToSec(firstTokenMs) }),
  };
}

/** Per-attempt fields both builders take. `attempt` is Playwright's retry index (0 = first run). */
type AttemptTiming = { attempt?: number; firstTokenMs?: number };

/**
 * `artifactRendered` is whether an artifact card (or its placeholder) was on the newest reply. On a
 * prompt that does not declare generatesArtifact that is a silent mode switch: the model built an
 * artifact instead of answering in chat (observed on an unflagged analysis prompt), so the stream
 * window times artifact generation. The result leaves the gated median but is flagged
 * unexpectedArtifact so the switch is reported instead of hidden.
 */
export function completedResult(
  scenario: PromptScenario,
  args: AttemptTiming & { response: string; responseTimeMs: number; renderTimeMs: number; artifactRendered?: boolean }
): PromptResult {
  const responseTimeSec = msToSec(args.responseTimeMs);
  const unexpectedArtifact = Boolean(args.artifactRendered) && !scenario.generatesArtifact && !scenario.expectsImage;
  return {
    ...baseResult(scenario, args.attempt ?? 0, args.firstTokenMs),
    ...(unexpectedArtifact && { measuresDeliverable: true, unexpectedArtifact: true }),
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
 * statistic instead of dropping it, and latencyBreach fails the cell on it outright.
 */
export function incompleteResult(
  scenario: PromptScenario,
  elapsedMs: number,
  timing: AttemptTiming = {}
): PromptResult {
  return {
    ...baseResult(scenario, timing.attempt ?? 0, timing.firstTokenMs),
    response: '',
    responseTimeMs: elapsedMs,
    responseTimeSec: msToSec(elapsedMs),
    responseRateCharsPerSec: 0,
    renderTimeMs: 0,
    renderTimeSec: 0,
    incomplete: true,
  };
}

/**
 * Folds `next` into `prior`, one row per (id, attempt). Rewriting the same attempt replaces it;
 * a new attempt sits beside the earlier ones, which are marked `retried`. A retry used to overwrite
 * its first attempt, so a slow attempt that was retried and then passed vanished from the gate.
 */
export function mergeResults(prior: PromptResult[], next: PromptResult[]): PromptResult[] {
  const attemptOf = (r: PromptResult) => r.attempt ?? 0;
  const merged = [...new Map([...prior, ...next].map(r => [`${r.id}#${attemptOf(r)}`, r])).values()];

  const latestAttempt = new Map<string, number>();
  for (const r of merged) latestAttempt.set(r.id, Math.max(latestAttempt.get(r.id) ?? 0, attemptOf(r)));

  return merged.map(r => {
    const { retried: _stale, ...row } = r;
    return attemptOf(r) < (latestAttempt.get(r.id) ?? 0) ? { ...row, retried: true } : row;
  });
}

/** Rows in the latency gate: chat-streaming prompts only, every attempt included. */
function gatedResults(results: PromptResult[]): PromptResult[] {
  return results.filter(r => !r.measuresDeliverable);
}

/**
 * One value per gated prompt: the largest `value` over its attempts, skipping attempts where it is
 * undefined. Per prompt, so a flaky prompt's retries cannot outvote the other prompts in the median;
 * its slowest attempt, so the attempt that caused a retry still reaches the gate.
 */
function slowestPerPrompt(results: PromptResult[], value: (r: PromptResult) => number | undefined): number[] {
  const slowest = new Map<string, number>();
  for (const r of gatedResults(results)) {
    const v = value(r);
    if (v !== undefined) slowest.set(r.id, Math.max(slowest.get(r.id) ?? v, v));
  }
  return [...slowest.values()];
}

function medianSec(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median * 1000) / 1000;
}

/**
 * The cell's gated latency: the MEDIAN over gated prompts of each prompt's slowest attempt's
 * responseTimeSec, 0 when none.
 *
 * A median rather than a mean so one slow prompt cannot swing the cell against a tight threshold.
 * A retried prompt is judged on its slowest attempt (see slowestPerPrompt). Image/artifact prompts
 * stay out - they measure deliverable generation, which would turn the gate red on generation time
 * and mask real streaming regressions.
 */
export function gatedMedianSec(results: PromptResult[]): number {
  return medianSec(slowestPerPrompt(results, r => r.responseTimeSec));
}

/**
 * Median time to first token, per prompt like gatedMedianSec; 0 when no prompt has one. An attempt
 * abandoned before its first token counts at its elapsed time, a floor like its responseTimeSec -
 * dropping it would bias the median low on exactly the slow nights. A completed reply that never
 * showed markdown answer text (code view) has no first token and is skipped.
 */
export function gatedMedianFirstTokenSec(results: PromptResult[]): number {
  return medianSec(slowestPerPrompt(results, r => r.firstTokenSec ?? (r.incomplete ? r.responseTimeSec : undefined)));
}

/**
 * Ids of unflagged prompts whose latest attempt answered with an artifact (excluded from the gate). A
 * retried artifact attempt whose retry answered in chat is in the median, so it is not listed.
 */
export function unexpectedArtifactIds(results: PromptResult[]): string[] {
  return [...new Set(results.filter(r => r.unexpectedArtifact && !r.retried).map(r => r.id))];
}

/**
 * The cell's latency verdict: a failure message when it breached thresholdSec, null otherwise.
 *
 * Must stay in sync with the aggregate step's Latency column in .github/workflows/e2e-ai-latency.yml:
 * a breach is a median over thresholdSec OR a gated prompt whose LATEST attempt was abandoned (an
 * abandoned prompt has no upper bound, so faster prompts could otherwise outvote it). An abandoned
 * attempt that a later retry completed only feeds its prompt's slowest attempt in the median. No
 * gated result is "No Data" there, not a breach, so it returns null here too.
 */
export function latencyBreach(results: PromptResult[], thresholdSec: number): string | null {
  const gated = gatedResults(results);
  if (gated.length === 0) return null;

  const medianLatencySec = gatedMedianSec(results);
  const abandoned = gated.filter(r => r.incomplete && !r.retried).map(r => r.id);
  if (medianLatencySec <= thresholdSec && abandoned.length === 0) return null;

  const causes: string[] = [];
  if (medianLatencySec > thresholdSec)
    causes.push(`median AI latency ${medianLatencySec}s exceeds the ${thresholdSec}s threshold`);
  if (abandoned.length > 0) causes.push(`${abandoned.length} prompt(s) never finished: ${abandoned.join(', ')}`);
  const timings = gated.map(r => {
    const flags = [r.incomplete && 'incomplete', r.retried && 'retried'].filter(Boolean);
    return `${r.id}=${r.responseTimeSec}s${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`;
  });
  return `Latency breach - ${causes.join('; ')} [${timings.join(', ')}]`;
}
