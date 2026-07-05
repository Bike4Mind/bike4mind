import { createAiLatencySuite } from './ai-latency-suite-factory';
import config from './fixtures/ai-latency/ai-latency-short-answers-config.json';
import type { PromptScenario } from './ai-latency-helpers';

createAiLatencySuite({
  prompts: config.prompts as PromptScenario[],
  describeLabel: 'Run 3 simple prompts with expected short answers',
  timeoutMultiplier: 5,
  thresholdSec: config.thresholdSec,
  resultsFilename: 'ai-latency-short-answers-results.json',
  disableSmartTools: true,
});
