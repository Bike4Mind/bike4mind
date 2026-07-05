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

  function prompt(index: number) {
    const scenario = selectedPrompts[index];

    test(scenario.prompt, async ({ navigationPage, chatPage, modelSelector }) => {
      test.setTimeout(timeoutMultiplier * TIMEOUTS.TEST);

      await navigationPage.navigateToNewChat();
      resolvedModel = await resolveSelectedModel(modelSelector);
      await modelSelector.selectTextModel(resolvedModel, disableSmartTools ? { disableSmartTools: true } : undefined);

      const startMs = Date.now();
      await chatPage.sendMessageAndWaitForResponse(scenario.prompt, TIMEOUTS.AI_RESPONSE);
      const responseTimeMs = Date.now() - startMs;

      const allTexts = await chatPage.aiResponseRoot.allInnerTexts();
      const responseText = allTexts.join('\n');

      const responseTimeSec = responseTimeMs / 1000;
      const responseRateCharsPerSec = responseText.length > 0 ? Math.round(responseText.length / responseTimeSec) : 0;

      const normalizedResponse = normalizeForMatch(responseText);
      const foundKeywords = scenario.expectedKeywords.filter(kw => normalizedResponse.includes(normalizeForMatch(kw)));
      const matchedKeyword = foundKeywords[0];

      expect
        .soft(
          matchedKeyword,
          `Keyword match failed — ` +
            `found: [${foundKeywords.length ? foundKeywords.join(', ') : 'none'}], ` +
            `missing: [${scenario.expectedKeywords.filter(kw => !foundKeywords.includes(kw)).join(', ')}]. ` +
            `Response: "${responseText.slice(0, 300)}"`
        )
        .toBeTruthy();

      collectedResults.push({
        id: scenario.id,
        prompt: scenario.prompt,
        response: responseText,
        responseTimeMs,
        responseTimeSec: Math.round(responseTimeSec * 1000) / 1000,
        responseRateCharsPerSec,
      });
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
      // Deduplicate by id - retried tests push a second entry; keep the last (retry result wins).
      const results = [...new Map(collectedResults.map(r => [r.id, r])).values()];

      const averageResponseTimeSec =
        results.length > 0
          ? Math.round((results.reduce((sum, r) => sum + r.responseTimeSec, 0) / results.length) * 1000) / 1000
          : 0;

      const output = {
        model: resolvedModel,
        timestamp: new Date().toISOString(),
        thresholdSec,
        averageResponseTimeSec,
        results,
      };

      // Deterministic path relative to this spec folder, not process.cwd() - in CI Playwright can run
      // with a repo-root CWD, which would write outside apps/client/ and miss the artifact upload.
      const resultsDir = path.resolve(__dirname, 'test-results', 'ai-latency');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(path.join(resultsDir, resultsFilename), JSON.stringify(output, null, 2));
    });

    for (let i = 0; i < 3; i++) {
      prompt(i);
    }
  });
}
