import fs from 'fs';
import path from 'path';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { StreamingTimeoutError } from './pages/ChatPage';
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
  mergeResults,
  gatedAverageSec,
} from './ai-latency-budget';

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
  const selectedPrompts = pickDeterministic(prompts, 3, dailySeed);
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
  // merging by id keeps each write monotonic. Safe without locking because the AI-latency suites run
  // serially (PW_WORKERS=1 in e2e-ai-latency.yml), so there is never a concurrent writer.
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
    const averageResponseTimeSec = gatedAverageSec(results);

    // Never downgrade an already-resolved model back to 'unknown' (a recycled worker starts fresh).
    const output = {
      model: model !== 'unknown' ? model : priorModel,
      timestamp: new Date().toISOString(),
      thresholdSec,
      averageResponseTimeSec,
      results,
    };

    fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  }

  function prompt(index: number) {
    const scenario = selectedPrompts[index];

    test(scenario.prompt, async ({ navigationPage, chatPage, modelSelector }) => {
      test.setTimeout(timeoutMultiplier * TIMEOUTS.TEST);

      await navigationPage.navigateToNewChat();
      resolvedModel = await resolveSelectedModel(modelSelector);
      await modelSelector.selectTextModel(resolvedModel, disableSmartTools ? { disableSmartTools: true } : undefined);

      const startMs = Date.now();
      let imageAsserted = false;
      // streamEndMs marks the end of the token stream (the send helper returns once the
      // stop-generation button is gone). The image render and artifact settle that follow are a
      // separate, much longer measurement, so latency and streaming rate below are taken over the
      // stream window only and the render/settle tail is recorded separately as renderTimeMs.
      let streamEndMs: number;
      try {
        if (scenario.expectsImage) {
          // The image is tool-produced around the stream (the stop button can hide only once
          // generation finishes; city-no-cars streams no caption, textlen 0), so the send needs the
          // image-generation budget, not just the render wait - a short send budget would throw
          // before the render budget is ever used. Do not gate on the text container (it only mounts
          // with the image); assert the image as the success signal.
          await chatPage.sendImageMessageAndWaitForResponse(scenario.prompt, TIMEOUTS.IMAGE_GENERATION);
          streamEndMs = Date.now();
          imageAsserted = await chatPage.tryWaitForImageResponse(TIMEOUTS.IMAGE_GENERATION);
        } else {
          // An artifact is likewise generated around the stream, so an artifact prompt needs the
          // image-generation budget for the send; plain text takes the derived streaming budget
          // (see textStreamBudgetMs in ai-latency-budget.ts).
          const sendBudget = scenario.generatesArtifact
            ? TIMEOUTS.IMAGE_GENERATION
            : textStreamBudgetMs(thresholdSec, scenario);
          await chatPage.sendMessageAndWaitForResponse(scenario.prompt, sendBudget);
          streamEndMs = Date.now();
          // Streaming completing does not mean the artifact resolved; wait out the placeholders so
          // the scrape below reads the finished reply, not "Generating artifact..."/"Loading artifact...".
          if (scenario.generatesArtifact) {
            await chatPage.waitForArtifactSettled(TIMEOUTS.IMAGE_GENERATION);
          }
        }
      } catch (err: unknown) {
        // Only a blown streaming budget is a latency observation. The send path also does
        // pre-stream setup - waiting for the send button to enable, gating on the response
        // container mounting - and stamping one of those flakes `incomplete` would count it into
        // the gated average, page the slow-responses channel and fail the nightly for something
        // that is not AI slowness. Anything else propagates untouched: the test still fails
        // loudly, it just does not claim a timing it never took.
        if (err instanceof StreamingTimeoutError) {
          const result = incompleteResult(scenario, Date.now() - startMs);
          collectedResults.push(result);
          persistResults(resolvedModel, [result]);
        }
        throw err;
      }
      const settleEndMs = Date.now();

      // Measure latency and streaming rate over the token-stream window only; keep the image
      // render / artifact settle as a separate number so a 6-minute artifact mount neither reads
      // as a slow stream nor distorts chars/sec (a short article over a long settle).
      const responseTimeMs = streamEndMs - startMs;
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

      const result = completedResult(scenario, { response: responseText, responseTimeMs, renderTimeMs });
      collectedResults.push(result);
      // Persist immediately so this prompt's numbers survive a later prompt's timeout/worker recycle.
      persistResults(resolvedModel, [result]);
    });
  }

  test.describe(describeLabel, () => {
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

    for (let i = 0; i < 3; i++) {
      prompt(i);
    }
  });
}
