import { createAiLatencySuite } from './ai-latency-suite-factory';
import config from './fixtures/ai-latency/ai-latency-intermediate-tools-config.json';
import type { PromptScenario } from './ai-latency-helpers';

createAiLatencySuite({
  prompts: config.prompts as PromptScenario[],
  describeLabel: 'Run 3 intermediate prompts using tools',
  timeoutMultiplier: 15,
  thresholdSec: config.thresholdSec,
  resultsFilename: 'ai-latency-intermediate-tools-results.json',
});
