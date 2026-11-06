import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

/**
 * Acceptance test for the stale-settings bug: on an always-on host the settings cache only
 * invalidates locally, so an admin flipping `enforceCredits` from another process used to be
 * ignored for up to the cache TTL (5 min). Here the real settings accessors run against a fake repo,
 * so the read path under test is the production one - no `getSettingsMap`/`getSettingsValue` stub.
 */
// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
// Pricing is stubbed flat in this file, so the per-round credit cap cannot be priced here; it is held
// open, and cliCompletions.creditCap.test.ts covers it on real pricing.
vi.mock('./completionCreditBudget', async importOriginal => ({
  ...(await importOriginal<typeof import('./completionCreditBudget')>()),
  affordableRoundBudget: () => ({ affordable: true, outputTokens: Number.MAX_SAFE_INTEGER }),
}));
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
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
  isAdaptiveThinkingByDefault: vi.fn(() => false),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model, _messages, _options, onChunk) => {
      await onChunk([''], { inputTokens: 100, outputTokens: 50 });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { getSettingsMap, shutdownSettingsCache } from '@bike4mind/utils';
import { executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';

const mockSubtractCredits = vi.mocked(subtractCredits);

/** A settings store whose `enforceCredits` value an admin can change between calls. */
function buildSettingsStore(initial: string) {
  const rows: Record<string, string> = { enforceCredits: initial };
  const toRow = (settingName: string) => ({ settingName, settingValue: rows[settingName] });
  return {
    // Model configurations are read with findOne; none are stored here.
    findOne: vi.fn(async () => null),
    findAll: vi.fn(async () => Object.keys(rows).map(toRow)),
    findBySettingNames: vi.fn(async (names: string[]) => names.filter(name => name in rows).map(toRow)),
    adminFlipsTo(value: string) {
      rows.enforceCredits = value;
    },
  };
}

function buildDb(adminSettings: ReturnType<typeof buildSettingsStore>) {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
  };
  return {
    db: {
      adminSettings: adminSettings as never,
      apiKeys: {} as never,
      creditTransactions: {} as never,
      users: users as never,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as never,
      organizations: { findById: vi.fn() } as never,
    },
    users,
  };
}

const baseParams = {
  userId: 'user1',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  apiKeyInfo: { keyId: 'k1', keyName: 'CI key' },
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion - admin settings are read fresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shutdownSettingsCache();
  });
  afterEach(() => {
    shutdownSettingsCache();
    vi.unstubAllEnvs();
  });

  it('honours an enforceCredits flip on the next completion, with no restart', async () => {
    // Enforcement can only be switched off on self-host; hosted keeps it on whatever the row says.
    vi.stubEnv('B4M_SELF_HOST', 'true');
    const adminSettings = buildSettingsStore('true');
    const { db, users } = buildDb(adminSettings);

    // Warm this process's cache the way an earlier request did.
    await getSettingsMap({ adminSettings });

    await executeCompletion({ ...baseParams, db });
    expect(users.incrementCredits).toHaveBeenCalledWith('user1', -10);
    expect(mockSubtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: CreditHolderType.User, apiKeyId: 'k1' }),
      expect.anything()
    );

    // Another process turns credit enforcement off. This process's cache never hears about it.
    adminSettings.adminFlipsTo('false');
    expect(await getSettingsMap({ adminSettings })).toEqual({ enforceCredits: 'true' });

    users.incrementCredits.mockClear();
    mockSubtractCredits.mockClear();

    await executeCompletion({ ...baseParams, db });

    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(mockSubtractCredits).not.toHaveBeenCalled();
  });

  it('passes skipCache for enforceCredits only, in one query', async () => {
    const adminSettings = buildSettingsStore('true');
    const { db } = buildDb(adminSettings);

    await executeCompletion({ ...baseParams, db });

    expect(adminSettings.findBySettingNames).toHaveBeenCalledExactlyOnceWith(['enforceCredits']);
    expect(adminSettings.findAll).not.toHaveBeenCalled();
  });
});
