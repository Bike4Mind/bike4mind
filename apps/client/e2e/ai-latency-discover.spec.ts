import fs from 'fs';
import path from 'path';
import { test } from './fixtures';
import { getLatestModels } from './ai-latency-helpers';

/**
 * Discovery-only run for the CI full-matrix job - NOT a latency benchmark.
 *
 * Reads the latest available GPT and Claude from the live AI Settings modal (the same
 * source of truth a latency spec selects from) and writes them to discovered-models.json.
 * The `discover-models` job in `.github/workflows/e2e-ai-latency.yml` parses that file to
 * build the full matrix, so the schedule/full-matrix runs pin to whatever models the
 * target environment actually offers instead of a hard-coded pair.
 */
test('discover latest GPT and Claude from AI settings modal', async ({ page, basePage, modelSelector }) => {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await basePage.dismissModals();

  const { gpt, claude } = await getLatestModels(modelSelector);

  // Write next to the latency results so the workflow's artifact/result globbing finds it.
  const outDir = path.resolve(__dirname, 'test-results', 'ai-latency');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'discovered-models.json'),
    JSON.stringify({ gpt: gpt ?? null, claude: claude ?? null }, null, 2)
  );

  // Surface in CI logs for quick debugging of an empty/partial discovery.
  console.log(`[discover-models] gpt=${gpt ?? 'none'} claude=${claude ?? 'none'}`);
});
