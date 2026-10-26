import fs from 'fs';
import path from 'path';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import {
  resolveSelectedModel,
  dailySeed,
  pickDeterministic,
  type PromptScenario,
  type PromptResult,
} from './ai-latency-helpers';
import {
  assertBudgetConfig,
  textStreamBudgetMs,
  completedResult,
  incompleteResult,
  isLatencyObservation,
  mergeResults,
  gatedMedianSec,
  gatedMedianFirstTokenSec,
  latencyBreach,
  unexpectedArtifactIds,
  TurnTimer,
} from './ai-latency-budget';

// Title of the per-cell latency gate. The workflow's Quality column excludes it by this exact
// title so a slow-but-correct cell reads Quality=Pass, Latency=FAIL (e2e-ai-latency.yml).
const LATENCY_GATE_TITLE = 'median AI latency is within the threshold';

// Prompts drawn per cell, capped at the pool size (the tool and intermediate pools hold 5). Enough
// gated rows for the median to shrug off one slow prompt. Prompts run serially, so raising this
// lengthens the cell against the job's timeout-minutes in e2e-ai-latency.yml.
const PROMPTS_PER_CELL = 7;

// Normalizes to NFKC and strips invisible Unicode chars (zero-width joiners, soft hyphens,
// non-breaking spaces) before matching - innerText-scraped AI text can differ invisibly and break a plain .includes().
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .toLowerCase();
}

interface AiLatencySuiteOptions {
  prompts: PromptScenario[];
  describeLabel: string;
  timeoutMultiplier: number;
  thresholdSec: number;
  resultsFilename: string;
  disableSmartTools?: boolean;
}

export function createAiLatencySuite({
  prompts,
  describeLabel,
  timeoutMultiplier,
  thresholdSec,
  resultsFilename,
  disableSmartTools = false,
}: AiLatencySuiteOptions) {
  assertBudgetConfig(prompts);
  const selectedPrompts = pickDeterministic(prompts, PROMPTS_PER_CELL, dailySeed);
  const collectedResults: PromptResult[] = [];
  // Resolved on the first prompt against the live AI Settings modal, then reused for the
  // afterAll summary. Stays 'unknown' only if no prompt ran (e.g. all skipped).
  let resolvedModel = 'unknown';

  // Deterministic path relative to this spec folder, not process.cwd() - in CI Playwright can run
  // with a repo-root CWD, which would write outside apps/client/ and miss the artifact upload.
  const resultsDir = path.resolve(__dirname, 'test-results', 'ai-latency');
  const resultsPath = path.join(resultsDir, resultsFilename);

  // Fold newly collected results into whatever is already on disk, then rewrite the summary. Called
  // after every prompt (not only in afterAll) so a finished prompt's numbers are durable the instant
  // it completes: a LATER prompt that times out makes Playwright recycle the worker, which resets
  // this module's in-memory state - an afterAll that knew only in-memory results would then clobber
  // the file with a partial (or empty) set (the observed `results: []`). Reading the file back and
  // merging by id keeps each write monotonic.
  //
  // The unlocked read-modify-write is safe only because nothing writes this file concurrently, and
  // that rests on these invariants, not on PW_WORKERS (the job runs 3 workers, with fullyParallel):
  //  - `resultsFilename` is unique per spec, so specs never share a file (running several specs in
  //    one invocation is safe);
  //  - the describe below is `mode: 'default'`, which overrides fullyParallel: its prompts form one
  //    job, and after a failure the retry and the remaining prompts are re-queued as ONE job that
  //    starts only after the failed worker has run its afterAll;
  //  - exactly one project matches each ai-latency spec (playwright.config.ts);
  //  - repeatEach is 1: each repeat is a separate job, so repeats would write one file at once.
  // Breaking any of them makes two workers race here, and a lost update that drops an `incomplete`
  // row reads as a healthy cell. checkAiLatencyBudget.test.ts pins all but the project one.
  function persistResults(model: string, newResults: PromptResult[]) {
    fs.mkdirSync(resultsDir, { recursive: true });

    let priorResults: PromptResult[] = [];
    let priorModel = 'unknown';
    try {
      const prior = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      if (Array.isArray(prior.results)) priorResults = prior.results;
      if (typeof prior.model === 'string') priorModel = prior.model;
    } catch {
      // First prompt (no file yet) or an unreadable/partial file - start from an empty set.
    }

    const results = mergeResults(priorResults, newResults);

    // Never downgrade an already-resolved model back to 'unknown' (a recycled worker starts fresh).
    const output = {
      model: model !== 'unknown' ? model : priorModel,
      timestamp: new Date().toISOString(),
      thresholdSec,
      medianResponseTimeSec: gatedMedianSec(results),
      medianFirstTokenSec: gatedMedianFirstTokenSec(results),
      results,
    };

    fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  }

  function prompt(index: number) {
    const scenario = selectedPrompts[index];

    test(scenario.prompt, async ({ navigationPage, chatPage, modelSelector }) => {
      const testStartMs = Date.now();
      test.setTimeout(timeoutMultiplier * TIMEOUTS.TEST);

      await navigationPage.navigateToNewChat();
      resolvedModel = await resolveSelectedModel(modelSelector);
      await modelSelector.selectTextModel(resolvedModel, disableSmartTools ? { disableSmartTools: true } : undefined);

      const timer = new TurnTimer();
      const attempt = test.info().retry;
      let imageAsserted = false;
      let artifactRendered = false;
      // The clock starts at Enter (TurnTimer), so typing is not timed. streamEndMs marks the end
      // of the token stream (the send helper returns once the stop-generation button is gone). The
      // image render and artifact settle that follow are a separate, much longer measurement, so
      // latency and streaming rate below are taken over the stream window only and the
      // render/settle tail is recorded separately as renderTimeMs.
      let streamEndMs: number;
      try {
        if (scenario.expectsImage) {
          // The image is tool-produced around the stream (the stop button can hide only once
          // generation finishes; city-no-cars streams no caption, textlen 0), so the send needs the
          // image-generation budget, not just the render wait - a short send budget would throw
          // before the render budget is ever used. Do not gate on the text container (it only mounts
          // with the image); assert the image as the success signal.
          await chatPage.sendImageMessageAndWaitForResponse(scenario.prompt, TIMEOUTS.IMAGE_GENERATION, timer);
          streamEndMs = Date.now();
          imageAsserted = await chatPage.tryWaitForImageResponse(TIMEOUTS.IMAGE_GENERATION);
        } else {
          // An artifact is likewise generated around the stream, so an artifact prompt needs the
          // image-generation budget for the send; plain text takes the derived streaming budget
          // (see textStreamBudgetMs in ai-latency-budget.ts).
          const sendBudget = scenario.generatesArtifact
            ? TIMEOUTS.IMAGE_GENERATION
            : textStreamBudgetMs(thresholdSec, scenario);
          await chatPage.sendMessageAndWaitForResponse(scenario.prompt, sendBudget, timer);
          streamEndMs = Date.now();
          // Streaming completing does not mean the artifact resolved; wait out the placeholders so
          // the scrape below reads the finished reply, not "Generating artifact..."/"Loading artifact...".
          if (scenario.generatesArtifact) {
            await chatPage.waitForArtifactSettled(TIMEOUTS.IMAGE_GENERATION);
          } else if (await chatPage.hasArtifact()) {
            // A chat prompt that came back as an artifact: settle it so the scrape reads the final
            // reply, and flag it so the result is excluded from the gate (see completedResult).
            // The settle is bounded by the test's remaining time so a stuck placeholder cannot
            // outlast the test and discard the stream window already measured.
            artifactRendered = true;
            await chatPage
              .waitForArtifactSettled(
                Math.max(
                  1_000,
                  Math.min(TIMEOUTS.IMAGE_GENERATION, test.info().timeout - (Date.now() - testStartMs) - 15_000)
                )
              )
              .catch(() => undefined);
          }
        }
      } catch (err: unknown) {
        // Recording is narrowed to a blown streaming budget; see isLatencyObservation for why a
        // send-ready or mount flake must not be stamped as one.
        if (isLatencyObservation(err)) {
          const result = incompleteResult(scenario, timer.elapsedSinceSendMs(), {
            attempt,
            firstTokenMs: timer.firstTokenMs(),
          });
          collectedResults.push(result);
          persistResults(resolvedModel, [result]);
        }
        throw err;
      }
      const settleEndMs = Date.now();

      // Measure latency and streaming rate over the token-stream window only; keep the image
      // render / artifact settle as a separate number so a 6-minute artifact mount neither reads
      // as a slow stream nor distorts chars/sec (a short article over a long settle).
      const responseTimeMs = timer.elapsedSinceSendMs(streamEndMs);
      const renderTimeMs = settleEndMs - streamEndMs;

      const allTexts = await chatPage.aiResponseRoot.allInnerTexts();
      const responseText = allTexts.join('\n');

      // An image prompt's only trustworthy signal is the rendered image. Its keyword list is
      // generic prose ("here", "picture", "generated") that a refusal or any description also
      // satisfies (matching is a lowercased substring includes, so "here" even hits inside
      // "there"), so a keyword fallback would pass on a real image-generation outage. Soft-assert
      // the image instead: the Quality column turns red when no image renders, while latency for
      // the run still records and later prompts still execute. Text and artifact prompts validate
      // on keywords - and an artifact prompt that renders no artifact degrades to that same text
      // check, which is meaningful for prose (unlike the image list).
      if (scenario.expectsImage) {
        expect
          .soft(
            imageAsserted,
            `Expected a generated image for "${scenario.prompt}" but none rendered within ` +
              `${TIMEOUTS.IMAGE_GENERATION}ms - image generation may be unavailable or broken.`
          )
          .toBe(true);
      } else {
        const normalizedResponse = normalizeForMatch(responseText);
        const foundKeywords = scenario.expectedKeywords.filter(kw =>
          normalizedResponse.includes(normalizeForMatch(kw))
        );
        const matchedKeyword = foundKeywords[0];

        expect
          .soft(
            matchedKeyword,
            `Keyword match failed - ` +
              `found: [${foundKeywords.length ? foundKeywords.join(', ') : 'none'}], ` +
              `missing: [${scenario.expectedKeywords.filter(kw => !foundKeywords.includes(kw)).join(', ')}]. ` +
              `Response: "${responseText.slice(0, 300)}"`
          )
          .toBeTruthy();
      }

      const result = completedResult(scenario, {
        response: responseText,
        responseTimeMs,
        renderTimeMs,
        artifactRendered,
        attempt,
        firstTokenMs: timer.firstTokenMs(),
      });
      if (result.unexpectedArtifact) {
        test.info().annotations.push({
          type: 'unexpected-artifact',
          description: `${scenario.id} answered with an artifact instead of chat; excluded from the latency gate`,
        });
      }
      collectedResults.push(result);
      // Persist immediately so this prompt's numbers survive a later prompt's timeout/worker recycle.
      persistResults(resolvedModel, [result]);
    });
  }

  test.describe(describeLabel, () => {
    // Load-bearing: keeps this spec's prompts on one worker at a time (see persistResults).
    test.describe.configure({ mode: 'default' });

    test.beforeEach(async ({ page, basePage }) => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await basePage.dismissModals();
    });

    test.afterAll(() => {
      // Final summary rewrite, folding this worker's in-memory results into whatever is on disk.
      // Per-prompt persistence already survives worker recycling; this is the belt-and-suspenders pass.
      persistResults(resolvedModel, collectedResults);
    });

    for (let i = 0; i < selectedPrompts.length; i++) {
      prompt(i);
    }

    // Runs last in this describe (mode 'default', so a failed prompt does not retry the group), so it
    // judges every prompt including retries. Reads the merged file rather than collectedResults,
    // which a worker recycle after a failed prompt resets.
    test(LATENCY_GATE_TITLE, () => {
      let results: PromptResult[] = [];
      try {
        const persisted = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
        // Drop rows left on disk by earlier local runs that picked different prompts.
        const selectedIds = new Set(selectedPrompts.map(p => p.id));
        if (Array.isArray(persisted.results))
          results = persisted.results.filter((r: PromptResult) => selectedIds.has(r.id));
      } catch {
        // No file: no prompt recorded a timing, so there is nothing to judge.
      }
      const switched = unexpectedArtifactIds(results);
      if (switched.length > 0) {
        test.info().annotations.push({
          type: 'unexpected-artifact',
          description: `Excluded from the gate, answered with an artifact instead of chat: ${switched.join(', ')}`,
        });
      }
      test.skip(
        results.every(r => r.measuresDeliverable),
        switched.length > 0
          ? `No chat-mode latency was recorded for this cell (No Data); artifact-mode replies: ${switched.join(', ')}.`
          : 'No text-streaming latency was recorded for this cell (No Data).'
      );

      const breach = latencyBreach(results, thresholdSec);
      if (breach) test.info().annotations.push({ type: 'latency-breach', description: breach });
      expect(breach, breach ?? undefined).toBeNull();
    });
  });
}
