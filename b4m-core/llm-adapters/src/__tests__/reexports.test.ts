import {
  getLlmByModel,
  getAvailableModels,
  AnthropicBackend,
  OpenAIBackend,
  GeminiBackend,
  OllamaBackend,
  BFLBackend,
  XAIBackend,
  AWSBackend,
  AnthropicBedrockBackend,
  PipelineTimer,
  resolveDeprecatedModelId,
  ensureToolPairingIntegrity,
  stripAllToolBlocks,
} from '../index.js';
import { ChoiceStatus, DEFAULT_MAX_TOOL_CALLS, replaceLastToolResultObservationCanonical } from '../backend.js';

test('public exports resolve', () => {
  expect(typeof getLlmByModel).toBe('function');
  expect(typeof getAvailableModels).toBe('function');
  expect(PipelineTimer).toBeDefined();
  expect(resolveDeprecatedModelId).toBeDefined();
  expect(AnthropicBackend).toBeDefined();
  expect(OpenAIBackend).toBeDefined();
  expect(GeminiBackend).toBeDefined();
  expect(OllamaBackend).toBeDefined();
  expect(BFLBackend).toBeDefined();
  expect(XAIBackend).toBeDefined();
  expect(AWSBackend).toBeDefined();
  expect(AnthropicBedrockBackend).toBeDefined();
  expect(typeof ensureToolPairingIntegrity).toBe('function');
  expect(typeof stripAllToolBlocks).toBe('function');
});

test('./backend sub-path exports resolve', () => {
  expect(ChoiceStatus.STREAM).toBe('stream');
  expect(DEFAULT_MAX_TOOL_CALLS).toBe(10);
  expect(typeof replaceLastToolResultObservationCanonical).toBe('function');
});
