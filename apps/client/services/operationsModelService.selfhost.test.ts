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
  mockAdminSettings: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
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

const IMAGE = model('flux-pro-1.1', 'image', ModelBackend.BFL);
const BEDROCK_TEXT = model('claude-5-sonnet-bedrock', 'text', ModelBackend.Bedrock);
const GPT_MINI = model('gpt-4o-mini', 'text', ModelBackend.OpenAI);
const OLLAMA_CHAT = model('qwen2.5-coder:7b', 'text', ModelBackend.Ollama);
const OLLAMA_OTHER = model('llama3:8b', 'text', ModelBackend.Ollama);

const noCloudKeys = {
  openai: null,
  anthropic: null,
  gemini: null,
  bfl: null,
  ollama: 'http://localhost:11434',
  xai: null,
};

function primeDefaults(models: ModelInfo[]) {
  // findOne(...).lean().exec() -> null forces getOperationsModel into getDefaultOperationsModel.
  mockAdminSettings.findOne.mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
  mockAdminSettings.findOneAndUpdate.mockResolvedValue({});
  mockGetAvailableModels.mockResolvedValue(models);
  mockGetLlmByModel.mockReturnValue({ complete: vi.fn() });
  mockGetDefaultImageModel.mockReturnValue(IMAGE);
}

describe('OperationsModelService self-host default text model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_PULL_MODELS;
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_PULL_MODELS;
  });

  it('picks the first OLLAMA_PULL_MODELS token when self-host with no cloud key', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_PULL_MODELS = 'qwen2.5-coder:7b nomic-embed-text';
    mockGetEffectiveLLMApiKeys.mockResolvedValue(noCloudKeys);
    // Bedrock enumerated first, ahead of Ollama, to prove we skip it.
    primeDefaults([IMAGE, BEDROCK_TEXT, OLLAMA_CHAT, OLLAMA_OTHER]);

    const result = await OperationsModelService.getOperationsModel();

    expect(result.modelId).toBe('qwen2.5-coder:7b');
    expect(result.modelInfo.backend).toBe(ModelBackend.Ollama);
  });

  it('falls back to the first Ollama text model when the pull token is not present', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_PULL_MODELS = 'not-pulled:latest nomic-embed-text';
    mockGetEffectiveLLMApiKeys.mockResolvedValue(noCloudKeys);
    primeDefaults([IMAGE, BEDROCK_TEXT, OLLAMA_OTHER, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsModel();

    expect(result.modelId).toBe('llama3:8b');
    expect(result.modelInfo.backend).toBe(ModelBackend.Ollama);
  });

  it('does NOT prefer Ollama when a cloud text key is present', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_PULL_MODELS = 'qwen2.5-coder:7b';
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noCloudKeys, openai: 'sk-test' });
    primeDefaults([IMAGE, GPT_MINI, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsModel();

    expect(result.modelId).toBe('gpt-4o-mini');
  });

  it('does NOT prefer Ollama when not in self-host mode', async () => {
    // B4M_SELF_HOST unset
    process.env.OLLAMA_PULL_MODELS = 'qwen2.5-coder:7b';
    mockGetEffectiveLLMApiKeys.mockResolvedValue(noCloudKeys);
    primeDefaults([IMAGE, GPT_MINI, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsModel();

    expect(result.modelId).toBe('gpt-4o-mini');
  });
});
