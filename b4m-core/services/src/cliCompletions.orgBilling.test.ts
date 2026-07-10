import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

// Isolate the billing routing: stub the LLM layer, settings, and credit math so
// the test asserts *which pool* is reserved/settled, not token accounting.
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', () => ({ subtractCredits: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', backend: 'anthropic' }]),
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
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';

const mockSubtractCredits = vi.mocked(subtractCredits);

function buildDb(overrides: { org?: any } = {}) {
  const org = overrides.org ?? { id: 'org1', currentCredits: 500, maxCreditsPerMember: null, userDetails: [] };
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
  };
  const organizations = {
    findById: vi.fn().mockResolvedValue(org),
    incrementCredits: vi.fn().mockResolvedValue({ ...org, currentCredits: org.currentCredits - 10 }),
    updateUserDetails: vi.fn().mockResolvedValue(undefined),
  };
  const usageEvents = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: usageEvents as any,
      organizations: organizations as any,
    },
    users,
    organizations,
    usageEvents,
  };
}

const baseParams = {
  userId: 'user1',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  apiKeyInfo: { keyId: 'k1', keyName: 'CI key' },
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion - org billing routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reserves from and settles to the organization when billingOrganizationId is set', async () => {
    const { db, users, organizations, usageEvents } = buildDb();

    await executeCompletion({ ...baseParams, db, billingOrganizationId: 'org1' });

    // Reservation + adjustment go to the org pool, never the user's.
    expect(organizations.incrementCredits).toHaveBeenCalledWith('org1', -10);
    expect(users.incrementCredits).not.toHaveBeenCalled();

    // Per-member usage recorded against the acting user.
    expect(organizations.updateUserDetails).toHaveBeenCalledWith(
      'org1',
      'user1',
      expect.objectContaining({ creditsDelta: 10 })
    );

    // Ledger transaction owned by the org, tagged with the key.
    expect(mockSubtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'completion_api_usage',
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        apiKeyId: 'k1',
      }),
      expect.anything()
    );

    // Usage event owned by the org, actor preserved.
    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'org1', ownerType: CreditHolderType.Organization, userId: 'user1' })
    );
  });

  it('bills the user (not any org) when no billingOrganizationId is set', async () => {
    const { db, users, organizations } = buildDb();

    await executeCompletion({ ...baseParams, db });

    expect(users.incrementCredits).toHaveBeenCalledWith('user1', -10);
    expect(organizations.incrementCredits).not.toHaveBeenCalled();
    expect(organizations.updateUserDetails).not.toHaveBeenCalled();
    expect(mockSubtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user1', ownerType: CreditHolderType.User }),
      expect.anything()
    );
  });

  it('skips BOTH member tracking and the ledger row if the settlement holder fetch returns null', async () => {
    // Regression guard: updateUserDetails must not advance usedCredits without a
    // matching ledger transaction. Org loads fine at the top, then the settlement
    // re-fetch (creditDifference === 0 branch) comes back null.
    const { db, organizations } = buildDb();
    const org = { id: 'org1', currentCredits: 500, maxCreditsPerMember: null, userDetails: [] };
    organizations.findById.mockReset();
    organizations.findById.mockResolvedValueOnce(org).mockResolvedValue(null);

    await executeCompletion({ ...baseParams, db, billingOrganizationId: 'org1' });

    // Balance already moved atomically at reservation; but with no holder to
    // anchor the transaction, neither the member tracking nor the ledger write fire.
    expect(organizations.updateUserDetails).not.toHaveBeenCalled();
    expect(mockSubtractCredits).not.toHaveBeenCalled();
  });

  it('rejects when the org member credit cap would be exceeded', async () => {
    const { db } = buildDb({
      org: {
        id: 'org1',
        currentCredits: 500,
        maxCreditsPerMember: 5,
        userDetails: [{ id: 'user1', usedCredits: 0 }],
      },
    });

    await expect(executeCompletion({ ...baseParams, db, billingOrganizationId: 'org1' })).rejects.toThrow(
      /member credit limit/i
    );
  });
});
