import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';

// Controllable mocks for resolveDefaultChatModel's three dependencies. Hoisted so the
// vi.mock factories below can reference them; importOriginal preserves every other export
// so the heavy import graph (and the lazy-contract tests) keep working unchanged.
const { getEffectiveLLMApiKeysMock, getAvailableModelsMock, getLlmByModelMock } = vi.hoisted(() => ({
  getEffectiveLLMApiKeysMock: vi.fn(),
  getAvailableModelsMock: vi.fn(),
  getLlmByModelMock: vi.fn(),
}));

vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: getEffectiveLLMApiKeysMock },
  };
});

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: getAvailableModelsMock, getLlmByModel: getLlmByModelMock };
});

// Guardrail for the chat completion lazy contract:
// `getDefaultChatCompletionOptions()` previously lived as a module-level
// `export const defaultChatCompletionOptions` whose body invoked `getFilesStorage()`,
// `getGeneratedImageStorage()`, `Resource.websocket.managementEndpoint`, and
// `Resource.SECRET_ENCRYPTION_KEY.value` at module load time. Any Lambda whose link
// array omitted those resources crashed at cold start the moment something in the
// import chain pulled this file in (e.g. just to grab `getSharedTokenizer`).
//
// This test guards the lazy promise by tracking every SST `Resource.X` access and
// asserting the chat-completion-specific keys (`websocket`, `SECRET_ENCRYPTION_KEY`,
// `mcpHandler`) are NOT touched at import but ARE touched when the factory is invoked.
// Storage and database modules are mocked to isolate this module's own contract from
// upstream Resource access via `@server/utils/config`.

const resourceAccessLog: string[] = [];

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      const k = String(key);
      resourceAccessLog.push(k);
      return new Proxy({}, benignStub);
    },
  }),
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

// Mock `@server/utils/config` - its module body eagerly reads several `Resource.X.value`
// (notably `SECRET_ENCRYPTION_KEY`, `MONGODB_URI`, etc.) and would pollute the access
// log with import-time noise. That's a separate, pre-existing eager-Resource concern
// outside this PR's scope. Mocking here isolates the assertion to chatCompletionDefaults'
// own factory body.
vi.mock('@server/utils/config', () => ({
  Config: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => `mock-config-${String(key)}`,
  }),
}));

describe('chatCompletionDefaults factory lazy contract', () => {
  beforeEach(() => {
    resourceAccessLog.length = 0;
    vi.resetModules();
  });

  // 20s timeout: vi.resetModules() forces a cold re-import of a heavy chain
  // (@bike4mind/database x 24 repos, mcp, services, observability) on each test.
  it('does not access websocket, SECRET_ENCRYPTION_KEY, or mcpHandler at module import', async () => {
    await import('./chatCompletionDefaults');
    expect(resourceAccessLog).not.toContain('websocket');
    expect(resourceAccessLog).not.toContain('SECRET_ENCRYPTION_KEY');
    expect(resourceAccessLog).not.toContain('mcpHandler');
  }, 20000);

  it('exports getDefaultChatCompletionOptions as a function (factory, not eager const)', async () => {
    const mod = await import('./chatCompletionDefaults');
    expect(typeof mod.getDefaultChatCompletionOptions).toBe('function');
  }, 20000);

  it('accesses websocket and SECRET_ENCRYPTION_KEY only when factory is invoked', async () => {
    const mod = await import('./chatCompletionDefaults');
    resourceAccessLog.length = 0;
    mod.getDefaultChatCompletionOptions();
    expect(resourceAccessLog).toContain('websocket');
    expect(resourceAccessLog).toContain('SECRET_ENCRYPTION_KEY');
  }, 20000);

  it('memoizes the result — repeated calls return the same reference', async () => {
    const mod = await import('./chatCompletionDefaults');
    const first = mod.getDefaultChatCompletionOptions();
    const second = mod.getDefaultChatCompletionOptions();
    expect(first).toBe(second);
  }, 20000);
});

const makeModel = (id: string, backend: ModelBackend, type: ModelInfo['type'] = 'text'): ModelInfo =>
  ({ id, name: id, backend, type, contextWindow: 8192, max_tokens: 8192, pricing: {} }) as unknown as ModelInfo;

describe('resolveDefaultChatModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('hosted: returns the Bedrock schema default and does no key/model probing', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'false');
    const { resolveDefaultChatModel } = await import('./chatCompletionDefaults');
    const result = await resolveDefaultChatModel({ configuredModel: undefined, userId: 'u1' });
    expect(result.model).toBe(ChatModels.CLAUDE_5_SONNET_BEDROCK);
    expect(result.apiKeys).toBeUndefined();
    expect(result.models).toBeUndefined();
    expect(getEffectiveLLMApiKeysMock).not.toHaveBeenCalled();
    expect(getAvailableModelsMock).not.toHaveBeenCalled();
  }, 20000);

  it('self-host with an Anthropic key: substitutes the Bedrock default for its direct-API twin', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    getEffectiveLLMApiKeysMock.mockResolvedValue({ anthropic: 'sk-ant' });
    getAvailableModelsMock.mockResolvedValue([makeModel(ChatModels.CLAUDE_5_SONNET, ModelBackend.Anthropic)]);
    getLlmByModelMock.mockReturnValue({ backend: 'anthropic' });
    const { resolveDefaultChatModel } = await import('./chatCompletionDefaults');
    const result = await resolveDefaultChatModel({ configuredModel: undefined, userId: 'u1' });
    expect(result.model).toBe(ChatModels.CLAUDE_5_SONNET);
    expect(result.models).toBeDefined();
  }, 20000);

  it('self-host, no cloud key, one local Ollama model: falls back to the local model', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    getEffectiveLLMApiKeysMock.mockResolvedValue({ anthropic: null, ollama: 'http://ollama:11434' });
    getAvailableModelsMock.mockResolvedValue([
      makeModel(ChatModels.CLAUDE_5_SONNET, ModelBackend.Anthropic),
      makeModel('qwen2.5-coder:7b', ModelBackend.Ollama),
    ]);
    getLlmByModelMock.mockReturnValue(null); // configured cloud default has no usable key
    const { resolveDefaultChatModel } = await import('./chatCompletionDefaults');
    const result = await resolveDefaultChatModel({ configuredModel: ChatModels.CLAUDE_5_SONNET, userId: 'u1' });
    expect(result.model).toBe('qwen2.5-coder:7b');
  }, 20000);

  it('self-host, nothing usable: returns the unusable cloud default so the caller can reject it', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    getEffectiveLLMApiKeysMock.mockResolvedValue({ anthropic: null });
    getAvailableModelsMock.mockResolvedValue([]);
    getLlmByModelMock.mockReturnValue(null);
    const { resolveDefaultChatModel } = await import('./chatCompletionDefaults');
    const result = await resolveDefaultChatModel({ configuredModel: ChatModels.CLAUDE_5_SONNET, userId: 'u1' });
    expect(result.model).toBe(ChatModels.CLAUDE_5_SONNET);
    // Populated so the route guard has what it needs to detect the unusable model and raise a 400.
    expect(result.apiKeys).toBeDefined();
    expect(result.models).toEqual([]);
  }, 20000);

  it('self-host: preserves an explicit admin default when its provider key is present', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    getEffectiveLLMApiKeysMock.mockResolvedValue({ openai: 'sk-openai' });
    getAvailableModelsMock.mockResolvedValue([makeModel(ChatModels.GPT5, ModelBackend.OpenAI)]);
    getLlmByModelMock.mockReturnValue({ backend: 'openai' });
    const { resolveDefaultChatModel } = await import('./chatCompletionDefaults');
    const result = await resolveDefaultChatModel({ configuredModel: ChatModels.GPT5, userId: 'u1' });
    expect(result.model).toBe(ChatModels.GPT5);
  }, 20000);
});
