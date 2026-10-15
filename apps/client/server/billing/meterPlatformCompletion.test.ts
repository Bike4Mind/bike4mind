import { CreditHolderType, getTextModelCost, type ModelInfo } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  userFindById: vi.fn(),
  orgFindById: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  findBySettingName: vi.fn(),
  getUserEntitlements: vi.fn(),
  enforceCredits: true,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findOne: m.findBySettingName },
  creditTransactionRepository: {},
  organizationRepository: { findById: m.orgFindById, incrementCredits: m.orgIncrement },
  userRepository: { findById: m.userFindById, incrementCredits: m.userIncrement },
}));
vi.mock('@bike4mind/services', async () => {
  const creditService = await vi.importActual<typeof import('@bike4mind/services/creditService')>(
    '@bike4mind/services/creditService'
  );
  const services = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    organizationService: { isCurrentOrgMember: services.organizationService.isCurrentOrgMember },
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
  createModelAdmission,
  reserveCompletionCredits,
  settleCompletion,
} from './meterPlatformCompletion';

const logger = { error: vi.fn(), warn: vi.fn() };
const model = { id: 'sonnet', pricing: { 200_000: { input: 3 / 1e6, output: 15 / 1e6 } } } as unknown as ModelInfo;
const user = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', organizationId: null, tags: [], isAdmin: false, ...over }) as never;
const req = (apiKeyInfo?: unknown) => ({ user: user(), apiKeyInfo, logger }) as never;

describe('meterPlatformCompletion credits', () => {
  let balance: number;

  beforeEach(() => {
    vi.clearAllMocks();
    m.enforceCredits = true;
    balance = 1000;
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
      usd,
      ...usage,
    });

    expect(charged).toBeGreaterThan(0);
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
    await settleCompletion(reservation, req(), { model: 'sonnet', usd: 5, inputTokens: 1, outputTokens: 1 });
    expect(m.userIncrement).not.toHaveBeenCalled();
    expect(m.deductCredits).not.toHaveBeenCalled();
  });

  it('prices the ceiling on the full maxTokens', () => {
    expect(completionCeilingUsd(model, [{ role: 'user', content: 'x'.repeat(250) }], 4096)).toBeCloseTo(
      getTextModelCost(model, 100, 4096)
    );
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
});
