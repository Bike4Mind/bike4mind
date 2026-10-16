import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * executeCompletion (the /api/ai/v1/completions and CLI door) admits the requested model through the
 * shared modelAdmission rule before any backend is built: an entitlement-gated model is a 403 for a
 * caller without the entitlement, and runs for one who has it.
 */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

const h = vi.hoisted(() => ({
  model: {
    id: 'gated-model',
    type: 'text',
    backend: 'openai',
    max_tokens: 1000,
    pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
  },
  complete: vi.fn(),
  getLlmByModel: vi.fn(),
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([h.model]),
  getLlmByModel: h.getLlmByModel,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true),
  getSettingsByNames: vi.fn(),
}));

import { ForbiddenError } from '@bike4mind/common';
import { executeCompletion } from './cliCompletions';

function buildDb() {
  return {
    adminSettings: {
      findOne: vi.fn().mockResolvedValue({
        settingValue: [{ id: 'gated-model', enabled: true, allowedEntitlements: ['pro'] }],
      }),
    } as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
      findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000, tags: [] }),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
    organizations: {} as any,
  };
}

const run = (getEntitlements: () => Promise<string[]>) =>
  executeCompletion({
    userId: 'user1',
    model: 'gated-model',
    messages: [{ role: 'user', content: 'hi' }],
    onChunk: vi.fn().mockResolvedValue(undefined),
    db: buildDb(),
    getEntitlements,
  });

describe('executeCompletion model admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.complete.mockImplementation(async (_m, _msgs, _o, cb) => cb(['ok'], { inputTokens: 1, outputTokens: 1 }));
    h.getLlmByModel.mockReturnValue({ currentModel: '', complete: h.complete });
  });

  it('refuses an entitlement-gated model with a 403 before building a backend', async () => {
    await expect(run(async () => [])).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.getLlmByModel).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('runs the gated model for an entitled caller', async () => {
    await run(async () => ['pro']);
    expect(h.complete).toHaveBeenCalledOnce();
  });
});
