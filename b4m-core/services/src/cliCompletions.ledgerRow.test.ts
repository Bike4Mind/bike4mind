import { describe, it, expect, vi, beforeEach } from 'vitest';

// What the completion_api_usage ledger row carries beyond credits: cache tokens, the client's
// session and the tools the model called. Fixtures mirror cliCompletions.creditEvents.test.ts.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
const complete = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
  isAdaptiveThinkingByDefault: vi.fn(() => false),
  resolveOutputMaxTokens: vi.fn(
    ({ requested, fallback }: { requested?: number; fallback: number }) => requested ?? fallback
  ),
  getAvailableModels: vi.fn().mockResolvedValue([
    {
      id: 'test-model',
      type: 'text',
      backend: 'anthropic',
      pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
    },
  ]),
  getLlmByModel: vi.fn(() => ({ currentModel: '', complete })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 1),
  usdToCreditsStochastic: vi.fn(() => 1),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));

import { boundedToolNames, executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';

// any: partial repository doubles - only the methods executeCompletion calls are stubbed.
function buildDb() {
  const user = { id: 'user1', currentCredits: 100 };
  return {
    adminSettings: {} as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
  };
}

const run = (sessionId?: string) =>
  executeCompletion({
    userId: 'user1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    db: buildDb(),
    sessionId,
    source: 'desktop',
    onChunk: vi.fn().mockResolvedValue(undefined),
  });

const ledgerRow = () => vi.mocked(subtractCredits).mock.calls[0][0];

describe('executeCompletion - ledger row detail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records cache tokens, the session and the tools the model called', async () => {
    complete.mockImplementation(async (_model, _messages, _options, onChunk) => {
      await onChunk([''], { toolStarted: { name: 'read_file', id: 't1' } });
      await onChunk([''], {
        toolsUsed: [
          { name: 'read_file', arguments: '{}', id: 't1' },
          { name: 'bash', arguments: '{}', id: 't2' },
        ],
      });
      await onChunk(['done'], {
        inputTokens: 3,
        outputTokens: 900,
        cacheReadInputTokens: 180_000,
        cacheCreationInputTokens: 12_000,
      });
    });

    await run('desktop-session-1');

    expect(ledgerRow()).toMatchObject({
      type: 'completion_api_usage',
      sessionId: 'desktop-session-1',
      inputTokens: 3,
      outputTokens: 900,
      cacheReadTokens: 180_000,
      cacheWriteTokens: 12_000,
      metadata: expect.objectContaining({ toolNames: ['read_file', 'bash'] }),
    });
  });

  it('still settles and writes the row when a tool entry is malformed', async () => {
    complete.mockImplementation(async (_model, _messages, _options, onChunk) => {
      // A backend or fixture that strays from the { name } shape must not break settlement.
      await onChunk([''], { toolsUsed: ['bare-string', { arguments: '{}' }, null, { name: 'bash' }] });
      await onChunk(['done'], { inputTokens: 12, outputTokens: 3 });
    });

    await run('s-1');

    expect(vi.mocked(subtractCredits)).toHaveBeenCalledOnce();
    expect(ledgerRow().metadata).toMatchObject({ toolNames: ['bash'] });
  });

  it('leaves the session and tool names off a plain request', async () => {
    complete.mockImplementation(async (_model, _messages, _options, onChunk) => {
      await onChunk(['hi'], { inputTokens: 12, outputTokens: 3 });
    });

    await run();

    const row = ledgerRow();
    expect(row).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(row).not.toHaveProperty('sessionId', expect.anything());
    expect(row.metadata).not.toHaveProperty('toolNames');
  });
});

describe('boundedToolNames', () => {
  it('caps the count and the length of each name', () => {
    const names = Array.from({ length: 30 }, (_, i) => `${'x'.repeat(100)}${i}`);
    const bounded = boundedToolNames(names);
    expect(bounded).toHaveLength(20);
    expect(bounded.every(name => name.length === 64)).toBe(true);
  });
});
