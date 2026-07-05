import { createAiLatencySuite } from './ai-latency-suite-factory';
import config from './fixtures/ai-latency/ai-latency-tool-prompts-config.json';
import type { PromptScenario } from './ai-latency-helpers';

createAiLatencySuite({
  prompts: config.prompts as PromptScenario[],
  describeLabel: 'Run 3 simple prompts explicitly targeting tools',
  timeoutMultiplier: 10,
  thresholdSec: config.thresholdSec,
  resultsFilename: 'ai-latency-tool-prompts-results.json',
});
