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

    // Dedupe by id, last write wins so a retry's result supersedes the original.
    const results = [...new Map([...priorResults, ...newResults].map(r => [r.id, r])).values()];

    // The gated latency average must stay text-streaming-only. Image/artifact prompts measure a
    // much longer, different thing (deliverable generation, which for artifacts runs during the
    // stream), so fold only the text prompts into the average - otherwise the workflow's
    // AVG > thresholdSec check would go red on generation time and mask real streaming regressions.
    // Any 3-of-N pick includes at least one text prompt, but guard the empty case anyway.
    const gatedResults = results.filter(r => !r.measuresDeliverable);
    const averageResponseTimeSec =
      gatedResults.length > 0
        ? Math.round((gatedResults.reduce((sum, r) => sum + r.responseTimeSec, 0) / gatedResults.length) * 1000) / 1000
        : 0;

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
      if (scenario.expectsImage) {
        // Image flow: do not gate on the text container (it only mounts with the image), then
        // assert the image itself as the success signal. If no image renders within budget (e.g.
        // a model without image generation), fall through to the keyword check below rather than
        // hard-failing, so the suite stays meaningful across model capabilities. Budgets mirror
        // image-generation.spec.ts: the standard streaming budget for the send (the token stream
        // is short), the image-generation budget for the render (the long pole).
        await chatPage.sendImageMessageAndWaitForResponse(scenario.prompt, TIMEOUTS.AI_RESPONSE);
        imageAsserted = await chatPage.tryWaitForImageResponse(TIMEOUTS.IMAGE_GENERATION);
      } else {
        // An artifact is generated while the reply is still streaming (the stop button stays
        // visible), so an artifact prompt needs the image-generation budget for the send itself;
        // plain text keeps the standard streaming budget.
        const sendBudget = scenario.generatesArtifact ? TIMEOUTS.IMAGE_GENERATION : TIMEOUTS.AI_RESPONSE;
        await chatPage.sendMessageAndWaitForResponse(scenario.prompt, sendBudget);
        // Streaming completing does not mean the artifact resolved; wait out the placeholders so
        // the scrape below reads the finished reply, not "Generating artifact..."/"Loading artifact...".
        if (scenario.generatesArtifact) {
          await chatPage.waitForArtifactSettled(TIMEOUTS.IMAGE_GENERATION);
        }
      }
      const responseTimeMs = Date.now() - startMs;

      const allTexts = await chatPage.aiResponseRoot.allInnerTexts();
      const responseText = allTexts.join('\n');

      const responseTimeSec = responseTimeMs / 1000;
      const responseRateCharsPerSec = responseText.length > 0 ? Math.round(responseText.length / responseTimeSec) : 0;

      // Keyword-on-text validates prose replies. Skip it only when a rendered image was actually
      // asserted above: an image-only reply carries no caption, so keyword matching would be a
      // false negative. When an image prompt produced no image (imageAsserted false), fall through
      // and validate on text - the graceful path for models without image generation.
      if (!imageAsserted) {
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

      const result: PromptResult = {
        id: scenario.id,
        prompt: scenario.prompt,
        response: responseText,
        responseTimeMs,
        responseTimeSec: Math.round(responseTimeSec * 1000) / 1000,
        responseRateCharsPerSec,
        // Image/artifact prompts time end-to-end deliverable generation (image render / artifact
        // settle), not a text streaming rate - flag them so persistResults keeps them out of the
        // gated latency average, which must stay streaming-only to still catch a text regression.
        measuresDeliverable: Boolean(scenario.expectsImage || scenario.generatesArtifact),
      };
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
