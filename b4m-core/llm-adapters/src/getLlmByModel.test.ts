import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { ChatModels } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

vi.mock('./anthropicBackend', () => ({
  AnthropicBackend: vi.fn(function (this: any, key: string) {
    this._mock = 'anthropic';
    this.key = key;
    // The one mock that implements the optional hook, so the hand-off is assertable.
    this.setDispatchModel = vi.fn();
  }),
}));
vi.mock('./openaiBackend', () => ({
  OpenAIBackend: vi.fn(function (this: any, key: string) {
    this._mock = 'openai';
    this.key = key;
  }),
}));
vi.mock('./geminiBackend', () => ({
  GeminiBackend: vi.fn(function (this: any, key: string) {
    this._mock = 'gemini';
    this.key = key;
  }),
}));
vi.mock('./ollamaBackend', () => ({
  OllamaBackend: vi.fn(function (this: any, key: string) {
    this._mock = 'ollama';
    this.key = key;
  }),
}));
vi.mock('./bflBackend', () => ({
  BFLBackend: vi.fn(function (this: any, key: string) {
    this._mock = 'bfl';
    this.key = key;
  }),
}));
vi.mock('./xaiBackend', () => ({
  XAIBackend: vi.fn(function (this: any, key: string) {
    this._mock = 'xai';
    this.key = key;
  }),
}));
vi.mock('./awsBackend', () => ({
  AWSBackend: vi.fn(function (this: any) {
    this._mock = 'aws';
  }),
}));
vi.mock('./bedrockBackend/anthropic', () => ({
  default: vi.fn(function (this: any) {
    this._mock = 'bedrock-anthropic';
  }),
}));
vi.mock('./bedrockBackend/llama', () => ({
  default: vi.fn(function (this: any) {
    this._mock = 'bedrock-llama';
  }),
}));
vi.mock('./bedrockBackend/jurassicTwo', () => ({
  default: vi.fn(function (this: any) {
    this._mock = 'bedrock-jurassic';
  }),
}));
vi.mock('./bedrockBackend/titan', () => ({
  default: vi.fn(function (this: any) {
    this._mock = 'bedrock-titan';
  }),
}));
vi.mock('./bedrockBackend/deepseek', () => ({
  default: vi.fn(function (this: any) {
    this._mock = 'bedrock-deepseek';
  }),
}));

import {
  getLlmByModel,
  resetReplacedByOverlay,
  updateReplacedByOverlay,
  UnsupportedAdapterFamilyError,
  type ApiKeyTable,
} from './index';

function makeModelInfo(overrides: Partial<ModelInfo> & { backend: ModelInfo['backend'] }): ModelInfo {
  return {
    id: 'test-model' as ModelInfo['id'],
    type: 'text',
    name: 'Test Model',
    supportsImageVariation: false,
    contextWindow: 200000,
    max_tokens: 4096,
    pricing: { 200000: { input: 0.003, output: 0.015 } },
    ...overrides,
  };
}

const logger = new Logger();

const fullApiKeys: ApiKeyTable = {
  anthropic: 'anthropic-key',
  openai: 'openai-key',
  gemini: 'gemini-key',
  ollama: 'ollama-key',
  bfl: 'bfl-key',
  xai: 'xai-key',
};

describe('getLlmByModel', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when modelInfo is undefined', () => {
    expect(getLlmByModel(fullApiKeys, { logger })).toBeNull();
  });

  describe('anthropic backend', () => {
    const modelInfo = makeModelInfo({ backend: 'anthropic' });

    it('returns AnthropicBackend when key is present', () => {
      const result = getLlmByModel(fullApiKeys, { modelInfo, logger });
      expect((result as any)._mock).toBe('anthropic');
      expect((result as any).key).toBe('anthropic-key');
    });

    it('returns null when key is absent', () => {
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });

    it('throws when key is "expired"', () => {
      expect(() => getLlmByModel({ anthropic: 'expired' }, { modelInfo, logger })).toThrow(
        'Anthropic API key is expired'
      );
    });
  });

  describe('openai backend', () => {
    const modelInfo = makeModelInfo({ backend: 'openai' });

    it('returns OpenAIBackend when key is present', () => {
      const result = getLlmByModel(fullApiKeys, { modelInfo, logger });
      expect((result as any)._mock).toBe('openai');
    });

    it('returns null when key is absent', () => {
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });

    it('throws when key is "expired"', () => {
      expect(() => getLlmByModel({ openai: 'expired' }, { modelInfo, logger })).toThrow('OpenAI API key is expired');
    });
  });

  describe('gemini backend', () => {
    const modelInfo = makeModelInfo({ backend: 'gemini' });

    it('returns GeminiBackend when key is present', () => {
      expect((getLlmByModel(fullApiKeys, { modelInfo, logger }) as any)._mock).toBe('gemini');
    });

    it('returns null when key is absent', () => {
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });

    it('throws when key is "expired"', () => {
      expect(() => getLlmByModel({ gemini: 'expired' }, { modelInfo, logger })).toThrow('Gemini API key is expired');
    });
  });

  describe('ollama backend', () => {
    const modelInfo = makeModelInfo({ backend: 'ollama' });

    it('returns OllamaBackend when key is present', () => {
      expect((getLlmByModel(fullApiKeys, { modelInfo, logger }) as any)._mock).toBe('ollama');
    });

    it('returns null when key is absent', () => {
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });

    it('throws when key is "expired"', () => {
      expect(() => getLlmByModel({ ollama: 'expired' }, { modelInfo, logger })).toThrow('Ollama API key is expired');
    });
  });

  describe('bfl backend', () => {
    const modelInfo = makeModelInfo({ backend: 'bfl' });

    it('returns BFLBackend with provided key', () => {
      const result = getLlmByModel(fullApiKeys, { modelInfo, logger }) as any;
      expect(result._mock).toBe('bfl');
      expect(result.key).toBe('bfl-key');
    });

    it('returns BFLBackend with demo-key when no key is provided', () => {
      const result = getLlmByModel({}, { modelInfo, logger }) as any;
      expect(result._mock).toBe('bfl');
      expect(result.key).toBe('demo-key');
    });

    it('throws when key is "expired"', () => {
      expect(() => getLlmByModel({ bfl: 'expired' }, { modelInfo, logger })).toThrow('BFL API key is expired');
    });
  });

  describe('xai backend', () => {
    const modelInfo = makeModelInfo({ backend: 'xai' });

    it('returns XAIBackend when key is present', () => {
      expect((getLlmByModel(fullApiKeys, { modelInfo, logger }) as any)._mock).toBe('xai');
    });

    it('returns null when key is absent', () => {
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });

    it('throws when key is "expired"', () => {
      expect(() => getLlmByModel({ xai: 'expired' }, { modelInfo, logger })).toThrow('xAI API key is expired');
    });
  });

  describe('aws backend', () => {
    it('returns AWSBackend regardless of api keys', () => {
      const modelInfo = makeModelInfo({ backend: 'aws' });
      expect((getLlmByModel({}, { modelInfo, logger }) as any)._mock).toBe('aws');
    });
  });

  describe('bedrock backend', () => {
    it('routes Anthropic Claude models to AnthropicBedrockBackend', () => {
      for (const id of [
        ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
        ChatModels.CLAUDE_5_SONNET_BEDROCK,
        ChatModels.CLAUDE_4_7_OPUS_BEDROCK,
        ChatModels.CLAUDE_4_8_OPUS_BEDROCK,
        ChatModels.CLAUDE_3_5_HAIKU_BEDROCK,
      ]) {
        const result = getLlmByModel({}, { modelInfo: makeModelInfo({ backend: 'bedrock', id }), logger }) as any;
        expect(result._mock, `expected bedrock-anthropic for ${id}`).toBe('bedrock-anthropic');
      }
    });

    it('routes Llama models to LlamaBedrockBackend', () => {
      for (const id of [ChatModels.LLAMA3_INSTRUCT_8B_V1, ChatModels.LLAMA4_MAVERICK_17B_INSTRUCT_BEDROCK]) {
        const result = getLlmByModel({}, { modelInfo: makeModelInfo({ backend: 'bedrock', id }), logger }) as any;
        expect(result._mock, `expected bedrock-llama for ${id}`).toBe('bedrock-llama');
      }
    });

    it('routes Jurassic models to JurassicTwoBedrockBackend', () => {
      for (const id of [ChatModels.JURASSIC2_MID, ChatModels.JURASSIC2_ULTRA]) {
        const result = getLlmByModel({}, { modelInfo: makeModelInfo({ backend: 'bedrock', id }), logger }) as any;
        expect(result._mock, `expected bedrock-jurassic for ${id}`).toBe('bedrock-jurassic');
      }
    });

    it('routes Titan models to TitanBedrockBackend', () => {
      for (const id of [ChatModels.TITAN_TEXT_G1_LITE, ChatModels.TITAN_TEXT_G1_EXPRESS]) {
        const result = getLlmByModel({}, { modelInfo: makeModelInfo({ backend: 'bedrock', id }), logger }) as any;
        expect(result._mock, `expected bedrock-titan for ${id}`).toBe('bedrock-titan');
      }
    });

    it('routes DeepSeek models to DeepSeekBedrockBackend', () => {
      for (const id of [ChatModels.DEEPSEEK_R1_BEDROCK, ChatModels.DEEPSEEK_V3_1]) {
        const result = getLlmByModel({}, { modelInfo: makeModelInfo({ backend: 'bedrock', id }), logger }) as any;
        expect(result._mock, `expected bedrock-deepseek for ${id}`).toBe('bedrock-deepseek');
      }
    });

    it('returns null for an unrecognized bedrock model id', () => {
      const modelInfo = makeModelInfo({ backend: 'bedrock', id: 'unknown.model-v1:0' as ModelInfo['id'] });
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });
  });

  describe('unknown backend', () => {
    it('returns null for an unrecognized backend', () => {
      const modelInfo = makeModelInfo({ backend: 'voyageai' as ModelInfo['backend'] });
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });
  });

  describe('adapterFamily dispatch', () => {
    // Every currently-dispatched id reaches its backend through the legacy
    // switch above; these cases only fire for a record the catalog resolved.
    it.each([
      ['anthropic-messages', 'anthropic'],
      ['openai-chat', 'openai'],
      ['openai-responses', 'openai'],
      ['gemini', 'gemini'],
      ['ollama', 'ollama'],
      ['xai', 'xai'],
      ['bfl', 'bfl'],
      ['aws', 'aws'],
      ['bedrock-anthropic', 'bedrock-anthropic'],
      ['bedrock-llama', 'bedrock-llama'],
      ['bedrock-deepseek', 'bedrock-deepseek'],
      ['bedrock-jurassic', 'bedrock-jurassic'],
      ['bedrock-titan', 'bedrock-titan'],
    ])('routes adapterFamily %s to the %s backend', (adapterFamily, expected) => {
      const modelInfo = makeModelInfo({
        backend: 'voyageai' as ModelInfo['backend'],
        adapterFamily: adapterFamily as ModelInfo['adapterFamily'],
      });
      expect((getLlmByModel(fullApiKeys, { modelInfo, logger }) as any)._mock).toBe(expected);
    });

    it('beats the backend field: the family is the routing decision', () => {
      // A Bedrock-hosted Claude whose record says bedrock-anthropic must not be
      // re-derived from the id switch, which would not know this id.
      const modelInfo = makeModelInfo({
        backend: 'bedrock',
        id: 'global.anthropic.claude-sonnet-9' as ModelInfo['id'],
        adapterFamily: 'bedrock-anthropic',
      });
      expect((getLlmByModel({}, { modelInfo, logger }) as any)._mock).toBe('bedrock-anthropic');
    });

    it('returns null when the family needs a key this caller does not have', () => {
      const modelInfo = makeModelInfo({ backend: 'openai', adapterFamily: 'openai-chat' });
      expect(getLlmByModel({}, { modelInfo, logger })).toBeNull();
    });

    it('throws on an expired key like the legacy switch does', () => {
      const modelInfo = makeModelInfo({ backend: 'anthropic', adapterFamily: 'anthropic-messages' });
      expect(() => getLlmByModel({ anthropic: 'expired' }, { modelInfo, logger })).toThrow(
        'Anthropic API key is expired'
      );
    });

    it('throws a named error for a family this build cannot construct', () => {
      const modelInfo = makeModelInfo({
        backend: 'voyageai' as ModelInfo['backend'],
        id: 'voyage-4' as ModelInfo['id'],
        adapterFamily: 'voyageai',
      });
      expect(() => getLlmByModel(fullApiKeys, { modelInfo, logger })).toThrow(UnsupportedAdapterFamilyError);
      expect(() => getLlmByModel(fullApiKeys, { modelInfo, logger })).toThrow(/voyageai.*voyage-4/);
    });
  });

  describe('dispatch record hand-off', () => {
    it('hands the resolved record to the backend on the legacy path', () => {
      const modelInfo = makeModelInfo({ backend: 'anthropic' });
      const backend = getLlmByModel(fullApiKeys, { modelInfo, logger }) as any;
      expect(backend.setDispatchModel).toHaveBeenCalledWith(modelInfo);
    });

    it('hands it over on the family path too', () => {
      const modelInfo = makeModelInfo({ backend: 'anthropic', adapterFamily: 'anthropic-messages' });
      const backend = getLlmByModel(fullApiKeys, { modelInfo, logger }) as any;
      expect(backend.setDispatchModel).toHaveBeenCalledWith(modelInfo);
    });

    it('does not require the hook: a backend without it still dispatches', () => {
      const modelInfo = makeModelInfo({ backend: 'openai' });
      expect((getLlmByModel(fullApiKeys, { modelInfo, logger }) as any)._mock).toBe('openai');
    });
  });

  describe('central deprecated-id resolution', () => {
    afterEach(() => resetReplacedByOverlay());

    it('is identity for a live id: the same record object reaches the backend', () => {
      const modelInfo = makeModelInfo({ backend: 'anthropic', id: 'claude-sonnet-4-6' as ModelInfo['id'] });
      const backend = getLlmByModel(fullApiKeys, { modelInfo, logger }) as any;
      expect(backend.setDispatchModel).toHaveBeenCalledWith(modelInfo);
      expect(backend.setDispatchModel.mock.calls[0][0]).toBe(modelInfo);
    });

    it('routes a sunset id to its successor backend, which the raw id cannot reach', () => {
      // The bedrock switch knows the successor id and not the retired one, so
      // without the resolve this call returns null.
      const modelInfo = makeModelInfo({
        backend: 'bedrock',
        id: 'anthropic.claude-3-5-sonnet-20240620-v1:0' as ModelInfo['id'],
      });
      const backend = getLlmByModel({}, { modelInfo, logger }) as any;
      expect(backend._mock).toBe('bedrock-anthropic');
    });

    it('dispatches the successor id, so the provider call names a model that still exists', () => {
      updateReplacedByOverlay({ 'claude-retired-9': 'claude-sonnet-4-6' });
      const modelInfo = makeModelInfo({ backend: 'anthropic', id: 'claude-retired-9' as ModelInfo['id'] });
      const backend = getLlmByModel(fullApiKeys, { modelInfo, logger }) as any;
      expect(backend.setDispatchModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-sonnet-4-6' }));
    });
  });

  describe('deprecated model warning', () => {
    it('logs a warning when invoked with a deprecated model', () => {
      const modelInfo = makeModelInfo({ backend: 'anthropic', deprecationDate: '2024-01-01' });
      getLlmByModel(fullApiKeys, { modelInfo, logger });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[model-sunset]'));
    });

    it('does not log a warning for a non-deprecated model', () => {
      const modelInfo = makeModelInfo({ backend: 'anthropic' });
      getLlmByModel(fullApiKeys, { modelInfo, logger });
      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});
