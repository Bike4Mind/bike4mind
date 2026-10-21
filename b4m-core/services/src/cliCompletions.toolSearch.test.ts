import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tool search on executeCompletion: refusals land before any credit is reserved, what reaches the
 * adapter for each backend, and provider blocks reach onChunk untouched.
 */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));

type CapturedOptions = {
  tools: Array<{ toolSchema: Record<string, unknown> }>;
  providerTools?: unknown[];
};
type OnChunk = (text: string[], info?: Record<string, unknown>) => Promise<void>;

let capturedOptions: CapturedOptions | undefined;
let availableModels: Array<Record<string, unknown>> = [];
const providerBlock = {
  provider: 'anthropic' as const,
  block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { query: 'x' } },
};

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => availableModels),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model: unknown, _messages: unknown, options: CapturedOptions, onChunk: OnChunk) => {
      capturedOptions = options;
      await onChunk([], { providerBlock });
      await onChunk(['done'], { inputTokens: 10, outputTokens: 5 });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { ChatModels, type CompletionTool } from '@bike4mind/common';
import { executeCompletion } from './cliCompletions';

const DIRECT_MODEL = { id: ChatModels.CLAUDE_5_5_OPUS, backend: 'anthropic', max_tokens: 8192 };
const BEDROCK_MODEL = { id: ChatModels.CLAUDE_5_5_OPUS_BEDROCK, backend: 'bedrock', max_tokens: 8192 };
const OPENAI_MODEL = { id: ChatModels.GPT5, backend: 'openai', max_tokens: 8192 };

const plainTool: CompletionTool = {
  toolSchema: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } },
};
const deferredTool: CompletionTool = {
  toolSchema: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' }, defer_loading: true },
};
const searchTool: CompletionTool = {
  serverTool: { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
};

function buildDb() {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
  };
  // Only users and usageEvents are reached; the rest stand in for the repository interfaces.
  return {
    adminSettings: {},
    apiKeys: {},
    creditTransactions: {},
    users,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Parameters<typeof executeCompletion>[0]['db'];
}

function run(model: string, tools: CompletionTool[], onChunk = vi.fn().mockResolvedValue(undefined)) {
  const db = buildDb();
  const promise = executeCompletion({
    userId: 'user1',
    model,
    messages: [{ role: 'user', content: 'weather?' }],
    options: { tools },
    db,
    onChunk,
  });
  return { promise, db, onChunk };
}

describe('executeCompletion - tool search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
  });

  it('refuses a server tool on a Bedrock-served model before reserving credits', async () => {
    availableModels = [BEDROCK_MODEL];
    const { promise, db } = run(ChatModels.CLAUDE_5_5_OPUS_BEDROCK, [deferredTool, searchTool]);

    await expect(promise).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { errorCode: 'tool_search_unsupported' },
    });
    expect(vi.mocked(db.users.incrementCredits)).not.toHaveBeenCalled();
    expect(capturedOptions).toBeUndefined();
  });

  it('refuses a server tool on a non-Anthropic model', async () => {
    availableModels = [OPENAI_MODEL];
    await expect(run(ChatModels.GPT5, [plainTool, searchTool]).promise).rejects.toMatchObject({
      additionalInfo: { errorCode: 'tool_search_unsupported' },
    });
  });

  it.each([
    ['a non-Anthropic model', OPENAI_MODEL],
    ['a Bedrock-served Claude model', BEDROCK_MODEL],
  ])('sends deferred tools as plain tools on %s', async (_label, model) => {
    availableModels = [model];
    await run(model.id, [deferredTool]).promise;

    expect(capturedOptions?.tools.map(t => t.toolSchema)).toEqual([plainTool.toolSchema]);
    expect(capturedOptions).not.toHaveProperty('providerTools');
  });

  it('forwards defer_loading and the server tool on a direct Anthropic model', async () => {
    availableModels = [DIRECT_MODEL];
    await run(ChatModels.CLAUDE_5_5_OPUS, [deferredTool, searchTool]).promise;

    expect(capturedOptions?.tools[0].toolSchema).toEqual(deferredTool.toolSchema);
    expect(capturedOptions?.providerTools).toEqual([searchTool.serverTool]);
  });

  it('leaves a plain-tool request exactly as before', async () => {
    availableModels = [DIRECT_MODEL];
    await run(ChatModels.CLAUDE_5_5_OPUS, [plainTool]).promise;

    expect(JSON.stringify(capturedOptions?.tools.map(t => t.toolSchema))).toBe(JSON.stringify([plainTool.toolSchema]));
    expect(capturedOptions).not.toHaveProperty('providerTools');
  });

  it('passes provider blocks through to onChunk untouched', async () => {
    availableModels = [DIRECT_MODEL];
    const { promise, onChunk } = run(ChatModels.CLAUDE_5_5_OPUS, [deferredTool, searchTool]);
    await promise;

    expect(onChunk).toHaveBeenCalledWith([], { providerBlock });
  });
});
