import { CREDITS_PER_USD_COST, CreditHolderType, getTextModelCost, type ModelInfo } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  userFindById: vi.fn(),
  orgFindById: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  findBySettingName: vi.fn(),
  getUserEntitlements: vi.fn(),
  recordUsageEvent: vi.fn(),
  enforceCredits: true,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findOne: m.findBySettingName },
  creditTransactionRepository: {},
  organizationRepository: { findById: m.orgFindById, incrementCredits: m.orgIncrement },
  userRepository: { findById: m.userFindById, incrementCredits: m.userIncrement },
  usageEventRepository: { record: m.recordUsageEvent },
}));
vi.mock('@bike4mind/services', async () => {
  const creditService = await vi.importActual<typeof import('@bike4mind/services/creditService')>(
    '@bike4mind/services/creditService'
  );
  const services = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    organizationService: { isCurrentOrgMember: services.organizationService.isCurrentOrgMember },
    assertOwnerHasCredits: services.assertOwnerHasCredits,
    latchUsage: services.latchUsage,
    creditService: { ...creditService, deductCreditsWithOrgSupport: m.deductCredits },
  };
});
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: () => m.enforceCredits,
}));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: m.getUserEntitlements }));

import {
  completionCeilingUsd,
  completionUsd,
  assertOwnerCanAfford,
  createModelAdmission,
  createRequestCompletionMeter,
  reserveCompletionCredits,
  settleCompletion,
} from './meterPlatformCompletion';

const logger = { error: vi.fn(), warn: vi.fn() };
const model = { id: 'sonnet', pricing: { 200_000: { input: 3 / 1e6, output: 15 / 1e6 } } } as unknown as ModelInfo;
const user = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', organizationId: null, tags: [], isAdmin: false, ...over }) as never;
const req = (apiKeyInfo?: unknown) => ({ user: user(), apiKeyInfo, logger, headers: {} }) as never;

describe('meterPlatformCompletion credits', () => {
  let balance: number;

  beforeEach(() => {
    vi.clearAllMocks();
    m.enforceCredits = true;
    balance = 1000;
    m.recordUsageEvent.mockReset().mockResolvedValue(undefined);
    m.userFindById.mockResolvedValue({ id: 'u1', isAdmin: false });
    m.userIncrement.mockImplementation(async (_id: string, delta: number) => ({ currentCredits: (balance += delta) }));
  });

  it('refuses a zero-credit caller with a 422 insufficient_credits', async () => {
    balance = 0;
    await expect(reserveCompletionCredits(req(), 1, 'Lattice chat')).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { errorCode: 'insufficient_credits' },
    });
    expect(balance).toBe(0);
  });

  it('charges a funded caller exactly the priced usage and writes one completion_api_usage row', async () => {
    const usage = { inputTokens: 1000, outputTokens: 500 };
    const usd = completionUsd(model, usage);
    expect(usd).toBeCloseTo(getTextModelCost(model, 1000, 500));

    const reservation = await reserveCompletionCredits(req({ keyId: 'k1' }), 0.1, 'Lattice chat');
    const charged = await settleCompletion(reservation, req({ keyId: 'k1' }), {
      model: 'sonnet',
      provider: 'anthropic',
      usd,
      ...usage,
    });

    const raw = usd * CREDITS_PER_USD_COST;
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThan(reservation.reservedCredits);
    expect([Math.floor(raw), Math.ceil(raw)]).toContain(charged);
    expect(balance).toBe(1000 - charged);
    expect(m.deductCredits).toHaveBeenCalledTimes(1);
    expect(m.deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'completion_api_usage',
        model: 'sonnet',
        apiKeyId: 'k1',
        inputTokens: 1000,
        outputTokens: 500,
        credits: charged,
      }),
      expect.anything(),
      expect.anything()
    );
    expect(m.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(m.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'completion_api',
        provider: 'anthropic',
        model: 'sonnet',
        costUsd: usd,
        creditsCharged: charged,
        apiKeyId: 'k1',
      })
    );
  });

  it('refunds in full and writes no row on a provider failure', async () => {
    const reservation = await reserveCompletionCredits(req(), 0.1, 'Lattice chat');
    expect(balance).toBeLessThan(1000);
    await reservation.refund();
    expect(balance).toBe(1000);
    expect(m.deductCredits).not.toHaveBeenCalled();
  });

  it('bills the organization, not the user, for an org-billed API key', async () => {
    let orgBalance = 500;
    m.orgFindById.mockResolvedValue({ id: 'o1', currentCredits: 500, userDetails: [], users: [{ userId: 'u1' }] });
    m.orgIncrement.mockImplementation(async (_id: string, delta: number) => ({
      currentCredits: (orgBalance += delta),
    }));
    const orgReq = req({ keyId: 'k1', billingOwnerType: CreditHolderType.Organization, organizationId: 'o1' });

    const reservation = await reserveCompletionCredits(orgReq, 0.01, 'Lattice chat');
    const charged = await settleCompletion(reservation, orgReq, {
      model: 'sonnet',
      provider: 'anthropic',
      usd: 0.005,
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(orgBalance).toBe(500 - charged);
    expect(balance).toBe(1000);
  });

  it('moves no balance and writes no row when credits are not enforced', async () => {
    m.enforceCredits = false;
    balance = 0;
    const reservation = await reserveCompletionCredits(req(), 5, 'Lattice chat');
    await settleCompletion(reservation, req(), {
      model: 'sonnet',
      provider: 'anthropic',
      usd: 5,
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(m.userIncrement).not.toHaveBeenCalled();
    expect(m.deductCredits).not.toHaveBeenCalled();
  });

  it('prices the ceiling on the full maxTokens', () => {
    expect(completionCeilingUsd(model, [{ role: 'user', content: 'x'.repeat(250) }], 4096)).toBeCloseTo(
      getTextModelCost(model, 100, 4096)
    );
  });

  it('prices every input token at the cache-write rate when the request writes the cache', () => {
    expect(completionCeilingUsd(model, [{ role: 'user', content: 'x'.repeat(250) }], 4096, true)).toBeCloseTo(
      (100 * 3 * 1.25) / 1e6 + (4096 * 15) / 1e6
    );
  });

  it('records the cache read and write tokens on the usage event', async () => {
    const reservation = await reserveCompletionCredits(req(), 0.1, 'Lattice chat');
    await settleCompletion(reservation, req(), {
      model: 'sonnet',
      provider: 'anthropic',
      usd: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
    });
    expect(m.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ cachedInputTokens: 300, cacheWriteTokens: 40 })
    );
  });

  it('gives each settled call its own requestId while keeping the session id', async () => {
    for (let i = 0; i < 2; i++) {
      const reservation = await reserveCompletionCredits(req(), 0.1, 'QuestMaster planning');
      await settleCompletion(reservation, req(), {
        model: 'sonnet',
        provider: 'anthropic',
        usd: 0.001,
        inputTokens: 10,
        outputTokens: 5,
        sessionId: 's1',
      });
    }
    const [first, second] = m.recordUsageEvent.mock.calls.map(call => call[0]);
    expect(first.sessionId).toBe('s1');
    expect(second.sessionId).toBe('s1');
    expect(first.requestId).not.toBe(first.sessionId);
    expect(first.requestId).not.toBe(second.requestId);
  });

  it('holds the ceiling once per provider turn and charges one turn when no usage is reported', async () => {
    m.findBySettingName.mockResolvedValue(null);
    const messages = [{ role: 'user' as const, content: 'x'.repeat(250) }];
    const oneTurnCredits = Math.ceil(completionCeilingUsd(model, messages, 1000) * CREDITS_PER_USD_COST);
    const metered = await createRequestCompletionMeter(req(), 'proactive messages')(model, messages, 1000, [model], 3);
    expect(1000 - balance).toBeGreaterThanOrEqual(3 * oneTurnCredits - 2);
    await metered.settle({});
    expect(1000 - balance).toBeLessThanOrEqual(oneTurnCredits + 1);
  });
});

describe('createModelAdmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findBySettingName.mockResolvedValue({
      settingValue: [
        { id: 'disabled', enabled: false },
        { id: 'gated', enabled: true, allowedUserTags: [], allowedEntitlements: ['pro'] },
      ],
    });
    m.getUserEntitlements.mockResolvedValue([]);
  });

  it('refuses a catalog-disabled model, even for an admin', async () => {
    await expect((await createModelAdmission(user({ isAdmin: true }))).assert('disabled')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Model "disabled" is not accessible and no fallback available',
    });
  });

  it('refuses an entitlement-gated model to a non-entitled user', async () => {
    await expect((await createModelAdmission(user())).assert('gated')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('admits an entitled user and an admin to a gated model', async () => {
    m.getUserEntitlements.mockResolvedValue(['pro']);
    await expect((await createModelAdmission(user())).assert('gated')).resolves.toBeUndefined();
    m.getUserEntitlements.mockClear();
    await expect((await createModelAdmission(user({ isAdmin: true }))).assert('gated')).resolves.toBeUndefined();
    expect(m.getUserEntitlements).not.toHaveBeenCalled();
  });

  it('admits a model with no config entry, and fails safe when entitlements cannot resolve', async () => {
    const admission = await createModelAdmission(user());
    expect(await admission.admits('unlisted')).toBe(true);
    m.getUserEntitlements.mockRejectedValue(new Error('db down'));
    expect(await (await createModelAdmission(user())).admits('gated')).toBe(false);
  });

  it('skips the picker access rules for a platform-chosen model but keeps the catalog checks', async () => {
    const system = await createModelAdmission(user(), [{ id: 'off', disabled: true } as ModelInfo], true);
    expect(await system.admits('gated')).toBe(true);
    expect(await system.admits('off')).toBe(false);
  });
});

describe('assertOwnerCanAfford', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.enforceCredits = true;
  });

  it('refuses a user with no credits and admits one with credits', async () => {
    await expect(assertOwnerCanAfford({ id: 'u1', currentCredits: 0 } as never)).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { errorCode: 'insufficient_credits' },
    });
    await expect(assertOwnerCanAfford({ id: 'u1', currentCredits: 5 } as never)).resolves.toBeUndefined();
  });

  it('checks the org pool, not the user, for an org seat', async () => {
    m.orgFindById.mockResolvedValue({ id: 'o1', currentCredits: 0, userDetails: [], users: [{ userId: 'u1' }] });
    await expect(
      assertOwnerCanAfford({ id: 'u1', organizationId: 'o1', currentCredits: 500 } as never)
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('admits anyone when credits are not enforced', async () => {
    m.enforceCredits = false;
    await expect(assertOwnerCanAfford({ id: 'u1', currentCredits: 0 } as never)).resolves.toBeUndefined();
  });
});
