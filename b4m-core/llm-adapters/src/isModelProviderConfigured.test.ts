import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { UndifferentiatedBedrockBackend } from './bedrockBackend/undifferentiated';
import { isModelProviderConfigured } from './index';

const selfHost = () => vi.stubEnv('B4M_SELF_HOST', 'true');

beforeEach(() => {
  vi.stubEnv('B4M_SELF_HOST', '');
  vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', '');
  vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('isModelProviderConfigured', () => {
  it('answers by whether the serving provider has a key', async () => {
    expect(await isModelProviderConfigured(ChatModels.GEMINI_2_5_FLASH, { gemini: 'k' })).toBe(true);
    expect(await isModelProviderConfigured(ChatModels.GEMINI_2_5_FLASH, { openai: 'k' })).toBe(false);
    expect(await isModelProviderConfigured(ChatModels.GEMINI_2_5_FLASH, null)).toBe(false);
  });

  it('treats a Bedrock-only id as configured on hosted, where the IAM role is always present', async () => {
    expect(await isModelProviderConfigured(ChatModels.CLAUDE_4_SONNET_BEDROCK, null)).toBe(true);
  });

  it('treats a Bedrock-only id as unconfigured on self-host without BEDROCK_AWS_* credentials', async () => {
    selfHost();
    expect(await isModelProviderConfigured(ChatModels.CLAUDE_4_SONNET_BEDROCK, null)).toBe(false);
  });

  it('treats a Bedrock-only id as configured on self-host with BEDROCK_AWS_* credentials', async () => {
    selfHost();
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'id');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'secret');
    expect(await isModelProviderConfigured(ChatModels.CLAUDE_4_SONNET_BEDROCK, null)).toBe(true);
  });

  describe('an id served by both Anthropic and Bedrock', () => {
    const shared = ChatModels.CLAUDE_4_SONNET;

    beforeEach(() => {
      vi.spyOn(UndifferentiatedBedrockBackend.prototype, 'getModelInfo').mockResolvedValue([
        { id: shared, type: 'text', name: 'shared', backend: ModelBackend.Bedrock } as ModelInfo,
      ]);
      selfHost();
    });

    it('is configured when only Anthropic is usable', async () => {
      expect(await isModelProviderConfigured(shared, { anthropic: 'k' })).toBe(true);
    });

    it('is configured when only Bedrock is usable', async () => {
      vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'id');
      vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'secret');
      expect(await isModelProviderConfigured(shared, null)).toBe(true);
    });

    it('is unconfigured when neither is usable', async () => {
      expect(await isModelProviderConfigured(shared, null)).toBe(false);
    });
  });

  it('answers false for a catalogued id no static table names, even with Ollama configured', async () => {
    expect(await isModelProviderConfigured(ChatModels.DEEPSEEK_R1, { ollama: 'http://ollama.local:11434' })).toBe(
      false
    );
  });
});
