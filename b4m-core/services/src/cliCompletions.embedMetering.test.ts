import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

// enforceCredits is read via getSettingsValue; make it controllable per test.
let enforceCredits = true;

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
  getSettingsValue: vi.fn((key: string) => (key === 'enforceCredits' ? enforceCredits : true)),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';

function buildDb() {
  const org = { id: 'org1', currentCredits: 500, maxCreditsPerMember: null, userDetails: [] };
  const usageEvents = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    db: {
      adminSettings: {} as never,
      apiKeys: {} as never,
      creditTransactions: {} as never,
      users: {
        incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
        findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
      } as never,
      usageEvents: usageEvents as never,
      organizations: {
        findById: vi.fn().mockResolvedValue(org),
        incrementCredits: vi.fn().mockResolvedValue({ ...org, currentCredits: org.currentCredits - 10 }),
        updateUserDetails: vi.fn().mockResolvedValue(undefined),
      } as never,
    },
    usageEvents,
  };
}

const baseParams = {
  userId: 'user1',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  apiKeyInfo: { keyId: 'k1', keyName: 'embed key' },
  billingOrganizationId: 'org1',
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion - unconditional usage metering (alwaysRecordUsage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceCredits = true;
  });

  it('records exactly one org usage event when enforceCredits is on (no double write)', async () => {
    enforceCredits = true;
    const { db, usageEvents } = buildDb();

    await executeCompletion({ ...baseParams, db, alwaysRecordUsage: true });

    expect(usageEvents.record).toHaveBeenCalledTimes(1);
    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'org1', ownerType: CreditHolderType.Organization, creditsCharged: 10 })
    );
  });

  it('records the org usage event even when enforceCredits is off, with creditsCharged 0 and no settlement', async () => {
    enforceCredits = false;
    const { db, usageEvents } = buildDb();

    await executeCompletion({ ...baseParams, db, alwaysRecordUsage: true });

    expect(usageEvents.record).toHaveBeenCalledTimes(1);
    expect(usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        creditsCharged: 0,
        costUsd: 0.001,
      })
    );
    // Metering is widened, settlement is NOT: with enforcement off, no ledger write
    // and no credit movement happen - the event never implies a charge that occurred.
    expect(vi.mocked(subtractCredits)).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db.organizations as any).incrementCredits).not.toHaveBeenCalled();
  });

  it('records no usage event when enforceCredits is off and alwaysRecordUsage is not set (legacy behavior preserved)', async () => {
    enforceCredits = false;
    const { db, usageEvents } = buildDb();

    await executeCompletion({ ...baseParams, db });

    expect(usageEvents.record).not.toHaveBeenCalled();
  });

  it('records finalCredits (not 0) via the fallback when an enforced run settles but the ledger write throws', async () => {
    enforceCredits = true;
    const { db, usageEvents } = buildDb();
    // Settlement runs (enforced), but the ledger write throws before recordUsageEvent
    // on the success path fires -> usageRecorded stays false -> the embed fallback records
    // the event with creditsCharged = finalCredits (the enforced arm), not 0.
    vi.mocked(subtractCredits).mockRejectedValueOnce(new Error('ledger write failed'));

    await executeCompletion({ ...baseParams, db, alwaysRecordUsage: true });

    expect(usageEvents.record).toHaveBeenCalledTimes(1);
    expect(usageEvents.record).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 10 }));
  });

  it('records no usage event when the model cannot be priced (modelInfo undefined), even with alwaysRecordUsage', async () => {
    enforceCredits = false;
    const { db, usageEvents } = buildDb();

    // A model absent from getAvailableModels yields modelInfo === undefined; both the
    // settlement and the embed metering fallback are guarded on modelInfo, so nothing
    // is recorded (no cost basis to record).
    await executeCompletion({ ...baseParams, model: 'model-not-in-catalog', db, alwaysRecordUsage: true });

    expect(usageEvents.record).not.toHaveBeenCalled();
  });
});

describe('executeCompletion - per-key spend accumulation (spend cap)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceCredits = true;
  });

  function buildDbWithUserApiKeys() {
    const built = buildDb();
    const incrementSpend = vi.fn().mockResolvedValue(undefined);
    return {
      db: { ...built.db, userApiKeys: { incrementSpend } as never },
      usageEvents: built.usageEvents,
      incrementSpend,
    };
  }

  it('increments per-key spend once with the settled credit amount', async () => {
    const { db, incrementSpend } = buildDbWithUserApiKeys();

    await executeCompletion({ ...baseParams, db, alwaysRecordUsage: true });

    expect(incrementSpend).toHaveBeenCalledTimes(1);
    expect(incrementSpend).toHaveBeenCalledWith('k1', 10);
  });

  it('increments per-key spend even when enforceCredits is off (real cost, while creditsCharged records 0)', async () => {
    enforceCredits = false;
    const { db, usageEvents, incrementSpend } = buildDbWithUserApiKeys();

    await executeCompletion({ ...baseParams, db, alwaysRecordUsage: true });

    // The cap must trip on actual usage cost regardless of the platform debit
    // toggle - an intentional divergence from UsageEvent.creditsCharged.
    expect(incrementSpend).toHaveBeenCalledWith('k1', 10);
    expect(usageEvents.record).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 0 }));
  });

  it('does not increment when the caller did not wire db.userApiKeys (non-embed paths)', async () => {
    const { db } = buildDb();

    await expect(executeCompletion({ ...baseParams, db, alwaysRecordUsage: true })).resolves.toBeUndefined();
  });

  it('does not increment without apiKeyInfo (JWT/web-chat completions)', async () => {
    const { db, incrementSpend } = buildDbWithUserApiKeys();

    await executeCompletion({ ...baseParams, apiKeyInfo: undefined, db });

    expect(incrementSpend).not.toHaveBeenCalled();
  });

  it('does not increment when the model cannot be priced (modelInfo undefined)', async () => {
    enforceCredits = false;
    const { db, incrementSpend } = buildDbWithUserApiKeys();

    await executeCompletion({ ...baseParams, model: 'model-not-in-catalog', db, alwaysRecordUsage: true });

    expect(incrementSpend).not.toHaveBeenCalled();
  });

  it('is fail-open: a rejected increment does not fail the completion', async () => {
    const { db, incrementSpend } = buildDbWithUserApiKeys();
    incrementSpend.mockRejectedValueOnce(new Error('mongo down'));

    await expect(executeCompletion({ ...baseParams, db, alwaysRecordUsage: true })).resolves.toBeUndefined();
    expect(incrementSpend).toHaveBeenCalledTimes(1);
  });
});
