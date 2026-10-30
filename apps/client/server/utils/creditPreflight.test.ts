import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mocks } = vi.hoisted(() => {
  // The enforceCredits default (hosted on, self-host off) is computed when the
  // settings module first loads, so pin the hosted environment before the import
  // below. Without this the default-on cases flip on a self-host shell.
  process.env.B4M_SELF_HOST = 'false';
  return {
    mocks: {
      findById: vi.fn(),
      orgFindById: vi.fn(),
      getSettingsMap: vi.fn(),
    },
  };
});

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  organizationRepository: {},
  creditTransactionRepository: {},
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mocks.orgFindById(...a) },
  // No samples and no settings rows: the spend cap reads defaults and never refuses here.
  newAccountSpendCapAdapters: {
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    personalSpendSince: async () => [],
  },
}));
// Real cap helper: the org branch's decision is the one under test.
vi.mock('@bike4mind/services', async () => {
  const creditService = await vi.importActual<typeof import('@bike4mind/services/creditService')>(
    '@bike4mind/services/creditService'
  );
  return { creditService: { isMemberCreditCapExceeded: creditService.isMemberCreditCapExceeded } };
});
// Keep the real getSettingsValue: the hosted default (enforcement on when the
// setting is unset) is the behaviour these tests exist to pin.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

import { assertPreflightCredits, InsufficientCreditsPreflightError } from './creditPreflight';

const check = (estimatedCredits?: number) =>
  assertPreflightCredits({ userId: 'u1', estimatedCredits, featureLabel: 'text-to-speech' });

const checkOrg = (estimatedCredits: number | undefined, organizationId = 'org1') =>
  assertPreflightCredits({
    userId: 'u1',
    estimatedCredits,
    featureLabel: 'text-to-speech',
    billingOrganizationId: organizationId,
  });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getSettingsMap.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertPreflightCredits', () => {
  it('reads enforceCredits past the settings cache so an admin flip applies on the next call', async () => {
    mocks.findById.mockResolvedValue({ currentCredits: 100 });
    await check(1);
    expect(mocks.getSettingsMap).toHaveBeenCalledWith(expect.anything(), {
      names: ['enforceCredits'],
      skipCache: true,
    });
  });

  describe('enforcement on (the hosted default when the setting is unset)', () => {
    it('rejects a user that does not exist', async () => {
      mocks.findById.mockResolvedValue(null);
      await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });

    it('rejects a zero balance even when the call is estimated free', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 0 });
      await expect(check(0)).rejects.toThrow('Insufficient credits for text-to-speech');
    });

    it('rejects a negative balance', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: -5 });
      await expect(check(0)).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });

    it('treats a missing currentCredits field as zero', async () => {
      mocks.findById.mockResolvedValue({});
      await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });

    it('admits any positive balance when no estimate is given', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 1 });
      await expect(check()).resolves.toBeUndefined();
    });

    it('rejects a positive balance that does not cover the estimate, naming both figures', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 3 });
      await expect(check(10)).rejects.toThrow(
        'You do not have enough credits for text-to-speech. You currently have 3 credits and this requires approximately 10.'
      );
    });

    it('admits a balance that exactly covers the estimate', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 10 });
      await expect(check(10)).resolves.toBeUndefined();
    });
  });

  describe('organization pool', () => {
    beforeEach(() => mocks.findById.mockResolvedValue({ currentCredits: 0 }));

    it('admits the request when the org pool covers the estimate, even with an empty personal balance', async () => {
      mocks.orgFindById.mockResolvedValue({ currentCredits: 100, userDetails: [] });
      await expect(checkOrg(50)).resolves.toBeUndefined();
    });

    it('rejects a pool that does not cover the estimate, naming the org balance', async () => {
      mocks.orgFindById.mockResolvedValue({ currentCredits: 10, userDetails: [] });
      await expect(checkOrg(50)).rejects.toThrow(
        'Your organization does not have enough credits for text-to-speech. It currently has 10 credits and this requires approximately 50.'
      );
    });

    it('rejects a zero-balance org pool', async () => {
      mocks.orgFindById.mockResolvedValue({ currentCredits: 0, userDetails: [] });
      await expect(checkOrg(0)).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });

    it('rejects a member at their cap before looking at the pool', async () => {
      mocks.orgFindById.mockResolvedValue({
        currentCredits: 10000,
        maxCreditsPerMember: 40,
        userDetails: [{ id: 'u1', usedCredits: 20, periodStart: new Date() }],
      });
      await expect(checkOrg(30)).rejects.toThrow('member credit limit');
    });

    it('rejects an organization that does not exist', async () => {
      mocks.orgFindById.mockResolvedValue(null);
      await expect(checkOrg(10)).rejects.toThrow('Billing organization not found');
    });

    it('admits a zero-balance pool when enforcement is off, but still requires the org to exist', async () => {
      vi.stubEnv('B4M_SELF_HOST', 'true');
      mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });
      mocks.orgFindById.mockResolvedValue({ currentCredits: 0, userDetails: [] });
      await expect(checkOrg(100)).resolves.toBeUndefined();

      mocks.orgFindById.mockResolvedValue(null);
      await expect(checkOrg(100)).rejects.toThrow('Billing organization not found');
    });
  });

  describe('enforcement off (an explicit false setting)', () => {
    beforeEach(() => {
      vi.stubEnv('B4M_SELF_HOST', 'true');
      mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });
    });

    it('admits a zero-balance user', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 0 });
      await expect(check(100)).resolves.toBeUndefined();
    });

    it('still rejects a user that does not exist', async () => {
      mocks.findById.mockResolvedValue(null);
      await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });
  });

  describe('read failures', () => {
    it('propagates a settings read failure rather than admitting', async () => {
      const boom = new Error('settings down');
      mocks.getSettingsMap.mockRejectedValue(boom);
      mocks.findById.mockResolvedValue({ currentCredits: 100 });
      await expect(check()).rejects.toBe(boom);
    });

    it('propagates a user read failure rather than admitting', async () => {
      const boom = new Error('db down');
      mocks.findById.mockRejectedValue(boom);
      await expect(check()).rejects.toBe(boom);
    });
  });
});
