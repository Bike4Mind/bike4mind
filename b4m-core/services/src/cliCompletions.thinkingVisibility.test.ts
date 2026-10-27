import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionInfo, ThinkingVisibility } from '@bike4mind/common';

/** What the completions stream forwards of a model's reasoning, per the caller's thinking visibility. */
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

type Frame = [(string | null | undefined)[], CompletionInfo?];
let frames: Frame[] = [];
let availableModels: Array<Record<string, unknown>> = [];
let capturedOptions: Record<string, unknown> | undefined;
let freeLevel: ThinkingVisibility = 'summary';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => availableModels),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(
      async (
        _model: unknown,
        _messages: unknown,
        options: Record<string, unknown>,
        onChunk: (...frame: Frame) => Promise<void>
      ) => {
        capturedOptions = options;
        for (const [text, info] of frames) await onChunk(text, info);
      }
    ),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((key: string) => (key.startsWith('thinkingVisibility') ? freeLevel : true)),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { executeCompletion } from './cliCompletions';

const modelRow = (id: string, backend: string) => ({
  id,
  type: 'text',
  backend,
  max_tokens: 64_000,
  can_think: true,
  pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
});

const CLAUDE_4 = 'claude-sonnet-4-5';
const CLAUDE_3 = 'claude-3-7-sonnet-20250219';
const INLINE_REASONER = 'deepseek-reasoner';

const thinkingBlocks = [{ type: 'thinking', thinking: 'provider text', signature: 'sig' }];
const toolUse = [{ name: 'read_file', arguments: '{}', id: 't1' }];

/** A tagged thinking block, then the answer, then a client-tool frame carrying the blocks to echo back. */
const taggedStream: Frame[] = [
  [['<think>'], { channel: 'reasoning' }],
  [['private trace'], { channel: 'reasoning' }],
  [['</think>'], { channel: 'reasoning' }],
  [[null, 'Visible answer.']],
  [[''], { toolsUsed: toolUse, thinking: thinkingBlocks, inputTokens: 10, outputTokens: 5 }],
];

/** Reasoning inlined untagged in the text channel, as the reasoning_content families send it. */
const inlineStream: Frame[] = [
  [['<think>private trace']],
  [['</think>Visible answer.'], { inputTokens: 10, outputTokens: 5 }],
];

function buildDb() {
  const user = { id: 'user1', currentCredits: 100_000 };
  return {
    adminSettings: {},
    apiKeys: {},
    creditTransactions: {},
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    },
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) },
    organizations: {},
  } as unknown as Parameters<typeof executeCompletion>[0]['db'];
}

async function run(
  model: string,
  getThinkingVisibility?: () => Promise<ThinkingVisibility>,
  options?: Parameters<typeof executeCompletion>[0]['options']
) {
  const onChunk = vi.fn().mockResolvedValue(undefined);
  await executeCompletion({
    userId: 'user1',
    model,
    messages: [{ role: 'user', content: 'hi' }],
    db: buildDb(),
    onChunk,
    options,
    ...(getThinkingVisibility && { getThinkingVisibility }),
  });
  const calls = onChunk.mock.calls as Array<[(string | null | undefined)[], CompletionInfo | undefined]>;
  return {
    text: calls.map(([text]) => text.filter(Boolean).join('')).join(''),
    thinking: calls.map(([, info]) => info?.thinking).filter(Boolean),
  };
}

describe('executeCompletion - thinking visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    freeLevel = 'summary';
    availableModels = [
      modelRow(CLAUDE_4, 'anthropic'),
      modelRow(CLAUDE_3, 'anthropic'),
      modelRow(INLINE_REASONER, 'deepseek'),
    ];
  });

  it('streams a free caller no reasoning text, tagged or inline', async () => {
    frames = taggedStream;
    const tagged = await run(CLAUDE_4, async () => 'none');
    expect(tagged.text).toBe('Visible answer.');

    frames = inlineStream;
    const inline = await run(INLINE_REASONER, async () => 'none');
    expect(inline.text).toBe('Visible answer.');
  });

  it('keeps the thinking blocks a client-tool turn must echo back when the provider summarizes them', async () => {
    frames = taggedStream;
    const { thinking } = await run(CLAUDE_4, async () => 'none');
    expect(thinking).toEqual([thinkingBlocks]);
  });

  it('drops thinking blocks that would carry the raw trace', async () => {
    frames = taggedStream;
    const { text, thinking } = await run(CLAUDE_3, async () => 'summary');
    expect(text).toBe('Visible answer.');
    expect(thinking).toEqual([]);
  });

  it('forwards provider-summarized reasoning at summary and withholds the raw trace', async () => {
    frames = taggedStream;
    expect((await run(CLAUDE_4, async () => 'summary')).text).toBe('<think>private trace</think>Visible answer.');

    frames = inlineStream;
    expect((await run(INLINE_REASONER, async () => 'summary')).text).toBe('Visible answer.');
  });

  it('leaves a paid caller at raw unchanged', async () => {
    frames = inlineStream;
    expect((await run(INLINE_REASONER, async () => 'raw')).text).toBe('<think>private trace</think>Visible answer.');
  });

  it('is unchanged when no resolver is wired', async () => {
    frames = inlineStream;
    expect((await run(INLINE_REASONER)).text).toBe('<think>private trace</think>Visible answer.');
  });

  it('falls back to the configured free level when the resolution fails', async () => {
    const failing = async (): Promise<ThinkingVisibility> => {
      throw new Error('subscription read failed');
    };
    frames = inlineStream;
    expect((await run(INLINE_REASONER, failing)).text).toBe('Visible answer.');

    freeLevel = 'raw';
    expect((await run(INLINE_REASONER, failing)).text).toBe('<think>private trace</think>Visible answer.');
  });

  it('keeps a Claude answer that mentions the marker literally', async () => {
    frames = [...taggedStream.slice(0, 3), [[null, 'Wrap it in <think> tags.']]];
    expect((await run(CLAUDE_4, async () => 'none')).text).toBe('Wrap it in <think> tags.');
  });

  it('does not request thinking where the provider would return it raw', async () => {
    frames = inlineStream;
    await run(CLAUDE_3, async () => 'summary', { thinking: { enabled: true }, reasoningEffort: 'high' });
    expect(capturedOptions).not.toHaveProperty('thinking');
    expect(capturedOptions).not.toHaveProperty('reasoningEffort');

    await run(CLAUDE_4, async () => 'none', { thinking: { enabled: true } });
    expect(capturedOptions).toHaveProperty('thinking');
  });

  it('turns DeepSeek reasoning off when it is withheld, so it is not billed', async () => {
    frames = inlineStream;
    await run(INLINE_REASONER, async () => 'none', { thinking: { enabled: true } });
    expect(capturedOptions).toMatchObject({ thinking: { enabled: false } });
  });

  it('leaves thinking unset when a non-DeepSeek inline reasoner is withheld', async () => {
    frames = inlineStream;
    await run(CLAUDE_3, async () => 'none', { thinking: { enabled: true } });
    expect(capturedOptions).not.toHaveProperty('thinking');
  });
});
