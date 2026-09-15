import { createAiLatencySuite } from './ai-latency-suite-factory';
import config from './fixtures/ai-latency/ai-latency-tool-prompts-config.json';
import type { PromptScenario } from './ai-latency-helpers';

createAiLatencySuite({
  prompts: config.prompts as PromptScenario[],
  describeLabel: 'Run 3 simple prompts explicitly targeting tools',
  // 15 * TEST = 900s: the image prompt sends and renders under the image-generation budget
  // (generation runs during the stream), which the prior 600s cap could not cover.
  timeoutMultiplier: 15,
  thresholdSec: config.thresholdSec,
  resultsFilename: 'ai-latency-tool-prompts-results.json',
});
