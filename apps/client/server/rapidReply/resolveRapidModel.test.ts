import { describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import { resolveRapidModel } from './resolveRapidModel';

/**
 * Guard for the production failure this module exists to prevent: a rapid-reply mapping row
 * pinned to `us.anthropic.claude-haiku-4-5-20251001-v1:0`, which a catalog lifecycle row
 * hid from getAvailableModels. The endpoint used to throw a BadRequestError there, which
 * surfaced as a recurring error-severity alert for a condition that costs the user nothing
 * but the TTFVT win. Every case below asserts BOTH the model chosen and the log severity.
 */
const BEDROCK_HAIKU_45 = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DIRECT_HAIKU_45 = 'claude-haiku-4-5-20251001';

function createModelInfo(overrides: Partial<ModelInfo> & { id: string; backend: ModelBackend }): ModelInfo {
  return {
    type: 'text',
    name: overrides.id,
    contextWindow: 200_000,
    max_tokens: 8192,
    supportsImageVariation: false,
    pricing: { 200000: { input: 0.001, output: 0.005 } },
    ...overrides,
  } as ModelInfo;
}

const createLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }) as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

/** Every warn message emitted, including the ones the shared fallback selector contributes. */
const warnLines = (logger: { warn: ReturnType<typeof vi.fn> }): string[] =>
  logger.warn.mock.calls.map(call => String(call[0]));

const bedrockHaiku = createModelInfo({ id: BEDROCK_HAIKU_45, backend: ModelBackend.Bedrock });
const directHaiku = createModelInfo({ id: DIRECT_HAIKU_45, backend: ModelBackend.Anthropic });
const gptMini = createModelInfo({ id: 'gpt-4o-mini', backend: ModelBackend.OpenAI });

const ALL_KEYS: ApiKeyTable = { anthropic: 'sk-ant-test', openai: 'sk-openai-test' };

describe('resolveRapidModel', () => {
  it('runs the mapped model unchanged when it is listed and reachable', () => {
    const logger = createLogger();

    const result = resolveRapidModel({
      mappedModelId: BEDROCK_HAIKU_45,
      models: [bedrockHaiku, directHaiku, gptMini],
      apiKeyTable: ALL_KEYS,
      logger,
      mappingId: 'mapping-1',
    });

    expect(result.status).toBe('ready');
    expect(result).toMatchObject({ modelId: BEDROCK_HAIKU_45 });
    expect(result).not.toHaveProperty('substitutedFor');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('degrades to the Anthropic-direct twin when the catalog has hidden the Bedrock id', () => {
    // The exact production state: the mapped id is absent from getAvailableModels because a
    // lifecycle row carries a past deprecationDate.
    const logger = createLogger();

    const result = resolveRapidModel({
      mappedModelId: BEDROCK_HAIKU_45,
      models: [directHaiku, gptMini],
      apiKeyTable: ALL_KEYS,
      logger,
      mappingId: 'mapping-1',
    });

    expect(result).toMatchObject({
      status: 'ready',
      modelId: DIRECT_HAIKU_45,
      substitutedFor: BEDROCK_HAIKU_45,
    });
    // The substitution is reported, but never at error severity.
    expect(warnLines(logger).some(line => line.includes(DIRECT_HAIKU_45))).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats a disabled mapped model as a fallback trigger', () => {
    // Listed so the picker can grey it out, but it must never run.
    const logger = createLogger();

    const result = resolveRapidModel({
      mappedModelId: BEDROCK_HAIKU_45,
      models: [{ ...bedrockHaiku, disabled: true, disabledReason: 'operator disabled' }, directHaiku],
      apiKeyTable: ALL_KEYS,
      logger,
    });

    expect(result).toMatchObject({ status: 'ready', modelId: DIRECT_HAIKU_45 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('forwards a sunset id with a known successor instead of substituting', () => {
    // anthropic.claude-3-haiku-20240307-v1:0 -> us.anthropic.claude-haiku-4-5-20251001-v1:0
    // in DEPRECATED_MODEL_MAP. A mapping row pinned to the old snapshot should land on the
    // successor as the primary, not go through the fallback chain.
    const logger = createLogger();

    const result = resolveRapidModel({
      mappedModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      models: [bedrockHaiku, directHaiku, gptMini],
      apiKeyTable: ALL_KEYS,
      logger,
    });

    expect(result).toMatchObject({ status: 'ready', modelId: BEDROCK_HAIKU_45 });
    expect(result).not.toHaveProperty('substitutedFor');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips rapid reply at warn severity when nothing is reachable', () => {
    const logger = createLogger();

    const result = resolveRapidModel({
      mappedModelId: BEDROCK_HAIKU_45,
      models: [directHaiku, gptMini],
      apiKeyTable: { anthropic: 'expired' },
      logger,
      mappingId: 'mapping-1',
    });

    expect(result).toEqual({ status: 'unavailable' });
    expect(warnLines(logger).some(line => line.includes('mapping-1'))).toBe(true);
    // The whole point: a rapid reply that cannot run is not an error-severity event. This is
    // what the recurring production alert actually was.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('degrades a model whose backend has no key rather than dispatching to it', () => {
    // Listed (Bedrock is keyless at listing time) but the Anthropic twin is what has a key.
    const logger = createLogger();

    const result = resolveRapidModel({
      mappedModelId: 'gpt-4o-mini',
      models: [gptMini, directHaiku],
      apiKeyTable: { anthropic: 'sk-ant-test' },
      logger,
    });

    expect(result).toMatchObject({ status: 'ready', modelId: DIRECT_HAIKU_45, substitutedFor: 'gpt-4o-mini' });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
