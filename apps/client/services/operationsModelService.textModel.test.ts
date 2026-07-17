import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';

const {
  mockAdminSettings,
  mockLogger,
  mockGetAvailableModels,
  mockGetLlmByModel,
  mockGetEffectiveLLMApiKeys,
  mockGetDefaultImageModel,
} = vi.hoisted(() => ({
  mockAdminSettings: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockGetAvailableModels: vi.fn(),
  mockGetLlmByModel: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockGetDefaultImageModel: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  AdminSettings: mockAdminSettings,
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys, getEffectiveApiKey: vi.fn() },
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: mockGetAvailableModels,
  getLlmByModel: mockGetLlmByModel,
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return mockLogger;
  }),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('../server/utils/modelResolvers', () => ({
  getDefaultImageModel: mockGetDefaultImageModel,
  getApiKeyTypeFromBackend: vi.fn(),
}));

const { OperationsModelService } = await import('./operationsModelService');

const model = (id: string, type: string, backend: ModelBackend): ModelInfo => ({ id, type, backend }) as ModelInfo;

const GPT_MINI = model('gpt-4o-mini', 'text', ModelBackend.OpenAI);
const OLLAMA_CHAT = model('qwen2.5-coder:7b', 'text', ModelBackend.Ollama);
const noCloudKeys = {
  openai: null,
  anthropic: null,
  gemini: null,
  bfl: null,
  ollama: 'http://localhost:11434',
  xai: null,
};

describe('OperationsModelService.getOperationsTextModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_PULL_MODELS;
    mockGetLlmByModel.mockReturnValue({ complete: vi.fn() });
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_PULL_MODELS;
  });

  it('resolves a text model with no image or speech, and does not touch getDefaultImageModel', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_PULL_MODELS = 'qwen2.5-coder:7b';
    mockAdminSettings.findOne.mockResolvedValue(null); // no configured operations model
    mockGetEffectiveLLMApiKeys.mockResolvedValue(noCloudKeys);
    // Only a text model is available - no image model at all.
    mockGetAvailableModels.mockResolvedValue([OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsTextModel();

    expect(result.modelId).toBe('qwen2.5-coder:7b');
    expect(result.modelInfo.backend).toBe(ModelBackend.Ollama);
    expect(result.llm).toBeDefined();
    expect('imageLlm' in result).toBe(false);
    expect(mockGetDefaultImageModel).not.toHaveBeenCalled();
  });

  it('honors the admin-configured operations model id', async () => {
    mockAdminSettings.findOne.mockResolvedValue({
      settingValue: { modelId: 'qwen2.5-coder:7b', imageModelId: 'x', speechModelId: 'y' },
    });
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noCloudKeys, openai: 'sk-test' });
    mockGetAvailableModels.mockResolvedValue([GPT_MINI, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsTextModel();

    expect(result.modelId).toBe('qwen2.5-coder:7b');
  });

  it('falls back to gpt-4o-mini when no config and a cloud key is present', async () => {
    mockAdminSettings.findOne.mockResolvedValue(null);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noCloudKeys, openai: 'sk-test' });
    mockGetAvailableModels.mockResolvedValue([GPT_MINI, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsTextModel();

    expect(result.modelId).toBe('gpt-4o-mini');
  });
});
