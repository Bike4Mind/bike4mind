import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChatModels,
  ModelBackend,
  getTextModelCost,
  usdToCredits,
  type CompletionInfo,
  type CompletionTool,
  type IMessage,
  type ModelInfo,
} from '@bike4mind/common';

/** Server-side Claude prompt caching on the completions path, and what settlement bills for it. */
// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

let capturedOptions: Record<string, unknown> | undefined;
let availableModels: ModelInfo[] = [];
let usage: CompletionInfo = { inputTokens: 100, outputTokens: 50 };
let llmFactory: () => unknown;

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => availableModels),
  getLlmByModel: vi.fn(() => llmFactory()),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  // Deterministic rounding, so a settlement amount can be asserted exactly.
  usdToCreditsStochastic: vi.fn((usd: number) => Math.ceil(usd * CREDITS_PER_USD)),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));

import { WORKFLOW_REMINDER_MARKER } from '@bike4mind/agents';
import { AnthropicBackend } from '@bike4mind/llm-adapters';
import { executeCompletion } from './cliCompletions';

const CREDITS_PER_USD = usdToCredits(1);
const perM = (usd: number) => usd / 1_000_000;

const modelInfo = (id: string, backend: ModelBackend, extraPricing: Record<string, number> = {}) =>
  ({
    id,
    type: 'text',
    name: id,
    backend,
    contextWindow: 200_000,
    max_tokens: 64_000,
    pricing: { 200_000: { input: perM(3), output: perM(15), ...extraPricing } },
    supportsImageVariation: false,
  }) as unknown as ModelInfo;

const CLAUDE_DIRECT = modelInfo(ChatModels.CLAUDE_4_5_SONNET, ModelBackend.Anthropic);
const CLAUDE_BEDROCK = modelInfo(ChatModels.CLAUDE_4_5_SONNET_BEDROCK, ModelBackend.Bedrock);
const LLAMA_BEDROCK = modelInfo(ChatModels.LLAMA3_INSTRUCT_70B_V1, ModelBackend.Bedrock);
const OPENAI = modelInfo(ChatModels.GPT4o, ModelBackend.OpenAI);
const GEMINI = modelInfo('gemini-test-model', ModelBackend.Gemini);

function stubLlm() {
  return {
    currentModel: '',
    complete: vi.fn(
      async (_model: unknown, _messages: unknown, options: Record<string, unknown>, onChunk: (...a: any[]) => any) => {
        capturedOptions = options;
        await onChunk([''], usage);
      }
    ),
  };
}

function buildDb() {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 1_000_000 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 1_000_000 }),
  };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
      organizations: {} as any,
    },
    users,
  };
}

const conversation: IMessage[] = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'hi' },
];

const tool: CompletionTool = {
  toolSchema: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
};

const run = async (info: ModelInfo, extra: Partial<Parameters<typeof executeCompletion>[0]> = {}) => {
  availableModels = [info];
  const { db, users } = buildDb();
  const onChunk = vi.fn().mockResolvedValue(undefined);
  await executeCompletion({
    userId: 'user1',
    model: info.id,
    messages: conversation,
    db,
    onChunk,
    source: 'cli',
    ...extra,
  });
  return { users, onChunk };
};

describe('executeCompletion - Claude prompt caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    usage = { inputTokens: 100, outputTokens: 50 };
    llmFactory = stubLlm;
  });

  describe('strategy handed to the backend', () => {
    it.each([
      ['direct Anthropic', CLAUDE_DIRECT],
      ['Bedrock Claude', CLAUDE_BEDROCK],
    ])('turns on 5m caching for %s, matching web chat', async (_name, info) => {
      await run(info, { options: { tools: [tool] } });
      expect(capturedOptions?.cacheStrategy).toEqual({
        enableCaching: true,
        cacheSystemPrompt: true,
        cacheTools: true,
        cacheConversationHistory: true,
        cacheTTL: '5m',
      });
    });

    it('does not cache tools when the request has none', async () => {
      await run(CLAUDE_DIRECT);
      expect(capturedOptions?.cacheStrategy).toMatchObject({ enableCaching: true, cacheTools: false });
    });

    it('does not cache the history of a single-message request, as web chat does not', async () => {
      await run(CLAUDE_DIRECT, { messages: [{ role: 'user', content: 'hi' }] });
      expect(capturedOptions?.cacheStrategy).toMatchObject({ enableCaching: false, cacheConversationHistory: false });
    });

    describe('by source', () => {
      const multiTurn: IMessage[] = [
        ...conversation,
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ];

      it.each(['cli', 'desktop'] as const)('caches the first round (system and user only) from %s', async source => {
        await run(CLAUDE_DIRECT, { source });
        expect(capturedOptions?.cacheStrategy).toMatchObject({ enableCaching: true, cacheConversationHistory: true });
      });

      it.each([['api'], [undefined]] as const)('leaves a one-shot call from source %s uncached', async source => {
        await run(CLAUDE_DIRECT, { source });
        expect(capturedOptions?.cacheStrategy).toMatchObject({ enableCaching: false, cacheConversationHistory: false });
      });

      it('caches an api conversation once it has an assistant message', async () => {
        await run(CLAUDE_DIRECT, { source: 'api', messages: multiTurn });
        expect(capturedOptions?.cacheStrategy).toMatchObject({
          enableCaching: true,
          cacheSystemPrompt: true,
          cacheConversationHistory: true,
          cacheTTL: '5m',
        });
      });

      it('applies the same rule to Bedrock Claude', async () => {
        await run(CLAUDE_BEDROCK, { source: 'api' });
        expect(capturedOptions?.cacheStrategy).toMatchObject({ enableCaching: false });
        await run(CLAUDE_BEDROCK, { source: 'api', messages: multiTurn });
        expect(capturedOptions?.cacheStrategy).toMatchObject({ enableCaching: true });
      });
    });

    describe('workflow reminder', () => {
      const reminder: IMessage = { role: 'user', content: `${WORKFLOW_REMINDER_MARKER}\n- [ ] open todo` };
      const history: IMessage[] = [...conversation, { role: 'assistant', content: 'a1' }];

      it('anchors history before a trailing workflow reminder', async () => {
        await run(CLAUDE_DIRECT, { messages: [...history, reminder] });
        expect(capturedOptions?.cacheStrategy).toMatchObject({
          enableCaching: true,
          historyCacheExcludeTrailingCount: 1,
        });
      });

      it('keeps the anchor on the last message when it is not a reminder', async () => {
        await run(CLAUDE_DIRECT, { messages: [...history, { role: 'user', content: 'u2' }] });
        expect(capturedOptions?.cacheStrategy).not.toHaveProperty('historyCacheExcludeTrailingCount');
      });

      it('does not mistake an assistant message that starts with the marker for a reminder', async () => {
        await run(CLAUDE_DIRECT, { messages: [...conversation, { role: 'assistant', content: reminder.content }] });
        expect(capturedOptions?.cacheStrategy).not.toHaveProperty('historyCacheExcludeTrailingCount');
      });
    });

    it.each([
      ['OpenAI', OPENAI],
      ['Gemini', GEMINI],
      ['a non-Claude Bedrock model', LLAMA_BEDROCK],
    ])('sets no strategy for %s', async (_name, info) => {
      await run(info, { options: { tools: [tool] } });
      expect(capturedOptions).not.toHaveProperty('cacheStrategy');
    });
  });

  describe('cache_control markers in the built Anthropic request', () => {
    type Block = { cache_control?: unknown };
    type Request = { system?: string | Block[]; tools?: Block[]; messages: Array<{ content: string | Block[] }> };

    const markers = (request: Request): number => {
      const count = (blocks: unknown) =>
        Array.isArray(blocks) ? (blocks as Block[]).filter(b => b.cache_control).length : 0;
      return count(request.system) + count(request.tools) + request.messages.reduce((n, m) => n + count(m.content), 0);
    };

    // The real adapter, so the strategy built by executeCompletion meets the real applyCaching and cap.
    const sentRequest = async (messages: IMessage[]): Promise<Request> => {
      const backend = new AnthropicBackend('test-key');
      const requests: Request[] = [];
      (backend as unknown as { _api: unknown })._api = {
        messages: {
          create: async (params: Request) => {
            requests.push(params);
            return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      };
      llmFactory = () => backend;
      await run(CLAUDE_DIRECT, { messages, options: { stream: false, tools: [tool] } });
      return requests[0];
    };

    it('marks the system prompt, history anchor and tools on an unflagged CLI request', async () => {
      const request = await sentRequest([
        ...conversation,
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ]);
      expect(markers(request)).toBe(3);
    });

    const anchoredOn = (request: Request): number[] =>
      request.messages.flatMap((m, i) => (Array.isArray(m.content) && m.content.some(b => b.cache_control) ? [i] : []));

    it('puts the history breakpoint on the last message when there is no reminder', async () => {
      const request = await sentRequest([
        ...conversation,
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ]);
      expect(anchoredOn(request)).toEqual([request.messages.length - 1]);
    });

    it('puts the history breakpoint before a trailing workflow reminder', async () => {
      const request = await sentRequest([
        ...conversation,
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: `${WORKFLOW_REMINDER_MARKER}\n- [ ] open todo` },
      ]);
      expect(anchoredOn(request)).toEqual([request.messages.length - 2]);
    });

    it('stays at or under 4 markers when the client also flags messages with cache: true', async () => {
      const request = await sentRequest([
        { role: 'system', content: 'shared head', cache: true },
        { role: 'system', content: 'session', cache: true },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1', cache: true },
        { role: 'user', content: 'u2', cache: true },
      ]);
      expect(markers(request)).toBeLessThanOrEqual(4);
      expect(markers(request)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('settlement', () => {
    const settledUsd = async (info: ModelInfo, reported: CompletionInfo) => {
      usage = reported;
      const { onChunk } = await run(info);
      return onChunk.mock.calls.at(-1)?.[1]?.usdCost as number;
    };
    const cached: CompletionInfo = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 4_000,
    };

    it.each([
      ['direct Anthropic', CLAUDE_DIRECT],
      ['Bedrock Claude', CLAUDE_BEDROCK],
    ])('bills %s cache reads at 0.1x and writes at 1.25x the input rate', async (_name, info) => {
      const usd = await settledUsd(info, cached);
      expect(usd).toBeCloseTo(1_000 * perM(3) + 500 * perM(15) + 20_000 * perM(3) * 0.1 + 4_000 * perM(3) * 1.25, 10);
    });

    it('bills reads at the catalog cache_read when one is published', async () => {
      const usd = await settledUsd(
        modelInfo(ChatModels.CLAUDE_4_5_SONNET, ModelBackend.Anthropic, { cache_read: perM(0.2) }),
        cached
      );
      expect(usd).toBeCloseTo(1_000 * perM(3) + 500 * perM(15) + 20_000 * perM(0.2) + 4_000 * perM(3) * 1.25, 10);
    });

    // The hold prices round one fully uncached, so the 1.25x write premium settles above it.
    it('charges the cache-write premium of a first turn as a shortfall against the hold', async () => {
      const text = (tokens: number) => 'x'.repeat(tokens * 2.5);
      const maxTokens = 1_024;
      usage = { inputTokens: 0, outputTokens: maxTokens, cacheCreationInputTokens: 30_000 };
      const { users } = await run(CLAUDE_DIRECT, {
        messages: [
          { role: 'system', content: text(10_000) },
          { role: 'user', content: text(20_000) },
        ],
        options: { maxTokens },
      });

      const hold = usdToCredits(getTextModelCost(CLAUDE_DIRECT, 30_000, maxTokens));
      const settled = Math.ceil((30_000 * perM(3) * 1.25 + maxTokens * perM(15)) * CREDITS_PER_USD);
      expect(settled).toBeGreaterThan(hold);
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -hold);
      expect(users.incrementCredits).toHaveBeenNthCalledWith(2, 'user1', hold - settled);
    });

    it('refunds a warm-cache turn, which reads at a tenth of what the hold priced', async () => {
      const text = (tokens: number) => 'x'.repeat(tokens * 2.5);
      const maxTokens = 1_024;
      usage = { inputTokens: 0, outputTokens: maxTokens, cacheReadInputTokens: 30_000 };
      const { users } = await run(CLAUDE_DIRECT, {
        messages: [
          { role: 'system', content: text(10_000) },
          { role: 'user', content: text(20_000) },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'next' },
        ],
        options: { maxTokens },
      });

      const refund = users.incrementCredits.mock.calls[1][1] as number;
      expect(refund).toBeGreaterThan(0);
    });
  });
});

describe('executeCompletion - 1-hour cache TTL', () => {
  const OPUS_DIRECT = modelInfo(ChatModels.CLAUDE_4_8_OPUS, ModelBackend.Anthropic);
  const text = (tokens: number) => 'x'.repeat(tokens * 2.5);
  const maxTokens = 1_024;
  const firstTurn: IMessage[] = [
    { role: 'system', content: text(10_000) },
    { role: 'user', content: text(20_000) },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    usage = { inputTokens: 100, outputTokens: 50 };
    llmFactory = stubLlm;
  });

  it('hands the requested TTL to the strategy on a model that takes it', async () => {
    await run(OPUS_DIRECT, { options: { cacheTtl: '1h' } });
    expect(capturedOptions?.cacheStrategy).toMatchObject({ cacheTTL: '1h' });
  });

  it('keeps 5 minutes on a model without the 1-hour TTL, and by default', async () => {
    await run(CLAUDE_DIRECT, { options: { cacheTtl: '1h' } });
    expect(capturedOptions?.cacheStrategy).toMatchObject({ cacheTTL: '5m' });
    await run(OPUS_DIRECT);
    expect(capturedOptions?.cacheStrategy).toMatchObject({ cacheTTL: '5m' });
  });

  it('settles writes of a 1-hour request at 2x input when the adapter reports no split', async () => {
    usage = { inputTokens: 0, outputTokens: maxTokens, cacheCreationInputTokens: 30_000 };
    const { users, onChunk } = await run(OPUS_DIRECT, { messages: firstTurn, options: { maxTokens, cacheTtl: '1h' } });

    const hold = -(users.incrementCredits.mock.calls[0][1] as number);
    const settled = Math.ceil((30_000 * perM(3) * 2 + maxTokens * perM(15)) * CREDITS_PER_USD);
    expect(users.incrementCredits).toHaveBeenNthCalledWith(2, 'user1', hold - settled);
    expect(onChunk.mock.calls.at(-1)?.[1]).toMatchObject({ creditsUsed: settled, cacheWrite1hInputTokens: 30_000 });
  });

  it('prices per-turn splits as reported', async () => {
    usage = {
      inputTokens: 0,
      outputTokens: maxTokens,
      cacheCreationInputTokens: 30_000,
      turnUsage: [
        { inputTokens: 0, outputTokens: maxTokens, cacheCreationInputTokens: 30_000, cacheWrite1hInputTokens: 10_000 },
      ],
    };
    const { users } = await run(OPUS_DIRECT, { messages: firstTurn, options: { maxTokens, cacheTtl: '1h' } });

    const hold = -(users.incrementCredits.mock.calls[0][1] as number);
    const writeUsd = 20_000 * perM(3) * 1.25 + 10_000 * perM(3) * 2;
    const settled = Math.ceil((writeUsd + maxTokens * perM(15)) * CREDITS_PER_USD);
    expect(users.incrementCredits).toHaveBeenNthCalledWith(2, 'user1', hold - settled);
  });

  it('stamps the usage event with the 1-hour writes and rate', async () => {
    usage = { inputTokens: 0, outputTokens: maxTokens, cacheCreationInputTokens: 30_000 };
    availableModels = [OPUS_DIRECT];
    const { db } = buildDb();
    await executeCompletion({
      userId: 'user1',
      model: OPUS_DIRECT.id,
      messages: firstTurn,
      db,
      onChunk: vi.fn().mockResolvedValue(undefined),
      source: 'desktop',
      options: { maxTokens, cacheTtl: '1h' },
    });
    await vi.waitFor(() => expect(db.usageEvents.record).toHaveBeenCalled());
    expect(db.usageEvents.record.mock.calls[0][0]).toMatchObject({
      cacheWriteTokens: 30_000,
      cacheWrite1hTokens: 30_000,
      rates: { cacheWrite1h: perM(3) * 2 },
    });
  });
});
