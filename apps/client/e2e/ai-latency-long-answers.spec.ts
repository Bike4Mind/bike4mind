import { createAiLatencySuite } from './ai-latency-suite-factory';
import config from './fixtures/ai-latency/ai-latency-long-answers-config.json';
import type { PromptScenario } from './ai-latency-helpers';

createAiLatencySuite({
  prompts: config.prompts as PromptScenario[],
  describeLabel: 'Run 3 simple prompts with expected longer answers',
  timeoutMultiplier: 8,
  thresholdSec: config.thresholdSec,
  resultsFilename: 'ai-latency-long-answers-results.json',
  disableSmartTools: true,
});
