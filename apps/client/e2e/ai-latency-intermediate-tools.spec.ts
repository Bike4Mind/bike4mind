import { createAiLatencySuite } from './ai-latency-suite-factory';
import config from './fixtures/ai-latency/ai-latency-intermediate-tools-config.json';
import type { PromptScenario } from './ai-latency-helpers';

createAiLatencySuite({
  prompts: config.prompts as PromptScenario[],
  describeLabel: 'Run 3 intermediate prompts using tools',
  // 20 * TEST = 1200s so a real failure surfaces as a clean assertion, not an opaque test
  // timeout: an artifact prompt can spend the image-generation send budget twice (the one
  // "request timed out" retry in sendMessageAndWaitForResponse) plus the artifact settle wait.
  timeoutMultiplier: 20,
  thresholdSec: config.thresholdSec,
  resultsFilename: 'ai-latency-intermediate-tools-results.json',
});
