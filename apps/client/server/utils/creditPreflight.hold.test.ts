import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, UnprocessableEntityError } from '@bike4mind/common';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    reserve: vi.fn(),
    refund: vi.fn(),
    reservedSettle: vi.fn(),
    deductCreditsWithOrgSupport: vi.fn(),
    userFindById: vi.fn(),
    orgFindById: vi.fn(),
    getSettingsMap: vi.fn(),
  },
}));

vi.mock('@server/billing/reserveRequestCredits', () => ({
  reserveRequestCredits: (...a: unknown[]) => mocks.reserve(...a),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: {
    isMemberCreditCapExceeded: vi.fn(() => false),
    deductCreditsWithOrgSupport: (...a: unknown[]) => mocks.deductCreditsWithOrgSupport(...a),
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mocks.orgFindById(...a) },
  creditTransactionRepository: {},
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
  getSettingsValue: (_name: string, settings: { enforceCredits?: string }) => settings.enforceCredits === 'true',
}));

import { holdPreflightCredits, InsufficientCreditsPreflightError } from './creditPreflight';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const user = { id: 'u1' };

const held = (overrides: Record<string, unknown> = {}) => ({
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  reservedCredits: 100,
  refund: (...a: unknown[]) => mocks.refund(...a),
  settle: (...a: unknown[]) => mocks.reservedSettle(...a),
  ...overrides,
});

const hold = (overrides: Record<string, unknown> = {}) =>
  holdPreflightCredits({
    req: { user: user as never, logger: logger as never },
    requiredCredits: 100,
    featureLabel: 'text-to-speech',
    ...overrides,
  });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'true' });
  mocks.reserve.mockResolvedValue(held());
  mocks.reservedSettle.mockResolvedValue(60);
  mocks.refund.mockResolvedValue(undefined);
  mocks.deductCreditsWithOrgSupport.mockResolvedValue(undefined);
  mocks.userFindById.mockResolvedValue({ id: 'u1' });
  mocks.orgFindById.mockResolvedValue({ id: 'org1' });
});

describe('holdPreflightCredits', () => {
  it('reserves on the durable request-credit primitive, with the org the route resolved', async () => {
    await hold({ billingOrganizationId: 'org1' });

    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCredits: 100,
        enforceCredits: true,
        featureLabel: 'text-to-speech',
        billingOrganizationId: 'org1',
      })
    );
  });

  it('settles the measured cost against the reservation and reports who was billed', async () => {
    const reservation = held({ ownerId: 'org1', ownerType: CreditHolderType.Organization });
    mocks.reserve.mockResolvedValue(reservation);

    const preflight = await hold({ billingOrganizationId: 'org1' });
    const charged = await preflight.settle(60, { type: 'text_to_speech_usage', model: 'tts-1', sessionId: 's1' });

    expect(charged).toBe(60);
    expect(mocks.reservedSettle).toHaveBeenCalledWith(60, expect.objectContaining({ type: 'text_to_speech_usage' }));
    expect(preflight.ownerId).toBe('org1');
    expect(preflight.ownerType).toBe(CreditHolderType.Organization);
  });

  it('returns the whole reservation when the provider call fails', async () => {
    const preflight = await hold();
    await preflight.release();

    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it('maps a credit refusal onto the preflight error the routes already answer', async () => {
    mocks.reserve.mockRejectedValue(new UnprocessableEntityError('not enough credits'));

    await expect(hold()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
  });

  it('passes a non-billing failure through untouched', async () => {
    const boom = new Error('settings down');
    mocks.reserve.mockRejectedValue(boom);

    await expect(hold()).rejects.toBe(boom);
  });

  // With enforcement off the reservation holds nothing, so settlement charges directly - these
  // routes have always billed, credits setting or not.
  describe('when nothing was reserved', () => {
    beforeEach(() => {
      mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });
      mocks.reserve.mockResolvedValue(
        held({ ownerId: 'org1', ownerType: CreditHolderType.Organization, reservedCredits: 0 })
      );
    });

    it('charges the measured cost against the payer the reservation resolved', async () => {
      const preflight = await hold({ billingOrganizationId: 'org1' });
      const charged = await preflight.settle(25, { type: 'text_to_speech_usage', model: 'tts-1', sessionId: 's1' });

      expect(charged).toBe(25);
      expect(mocks.deductCreditsWithOrgSupport).toHaveBeenCalledWith(
        expect.objectContaining({ credits: 25, organization: { id: 'org1' }, type: 'text_to_speech_usage' }),
        expect.anything()
      );
      expect(mocks.reservedSettle).not.toHaveBeenCalled();
    });

    it('logs the billing miss and resolves when the direct charge fails', async () => {
      mocks.deductCreditsWithOrgSupport.mockRejectedValue(new Error('ledger down'));
      const preflight = await hold();

      await expect(
        preflight.settle(25, { type: 'speech_to_text_usage', model: 'openai', sessionId: 's1' })
      ).resolves.toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        'text-to-speech credit settlement failed - billing may be missed',
        expect.objectContaining({ userId: 'u1', charged: 25 })
      );
    });

    it('returns a refund without touching the ledger', async () => {
      const preflight = await hold();
      await preflight.release();

      expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    });
  });
});
