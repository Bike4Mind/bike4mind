import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCreditsWithLedgerRow } from '../creditService';
import { releaseSignupTranche, unlockSignupGrant } from './stagedSignupGrant';

vi.mock('@bike4mind/db-core', () => ({ withTransaction: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('../creditService')>()),
  addCreditsWithLedgerRow: vi.fn(),
}));

type TestUser = Record<string, unknown> & { id: string };

describe('unassessed signup grant clamp (risk policy off)', () => {
  const SIGNUP = 5_000;
  const UNLOCK = 3_000;
  const LIMIT = 1_000;
  const paid: Array<{ credits: number; transactionId: string }> = [];
  let user: TestUser;

  const buildAdapters = () => {
    const settings: Record<string, unknown> = {
      signupGrantRiskPolicy: { enabled: false },
      signupGrantUnprotectedMaxCredits: LIMIT,
      signupGrantInviteBonusCredits: 200,
      signupGrantDripCap: 0,
    };
    const adapters = {
      db: {
        adminSettings: {
          findBySettingName: vi.fn(async (name: string) =>
            name in settings ? { settingName: name, settingValue: settings[name] } : null
          ),
        },
        creditTransactions: { findOne: vi.fn().mockResolvedValue(null) },
        creditLots: {},
        users: {
          findById: vi.fn(async () => user),
          update: vi.fn(async (patch: Record<string, unknown>) => {
            user = { ...user, ...patch };
            return user;
          }),
          claimFreeCreditGrant: vi.fn().mockResolvedValue(true),
          markInviteBonusPaid: vi.fn(),
        },
      },
      bypassBudget: true,
    };
    // Test doubles for the repository interfaces the service forwards to.
    return adapters as unknown as Parameters<typeof releaseSignupTranche>[1] & typeof adapters;
  };

  beforeEach(() => {
    paid.length = 0;
    user = {
      id: 'user-1',
      emailVerified: true,
      currentCredits: 0,
      signupInvite: { source: 'user' },
      signupGrant: {
        stage: 'pending_email',
        signupCredits: SIGNUP,
        unlockCredits: UNLOCK,
        creditsReleased: 0,
        nextCondition: 'email_verification',
      },
    };
    vi.mocked(addCreditsWithLedgerRow).mockReset();
    vi.mocked(addCreditsWithLedgerRow).mockImplementation(async input => {
      paid.push({ credits: input.credits, transactionId: input.transactionId as string });
      return {
        creditHolder: { currentCredits: paid.reduce((sum, row) => sum + row.credits, 0) },
        creditTransactionId: `tx-${paid.length}`,
      } as Awaited<ReturnType<typeof addCreditsWithLedgerRow>>;
    });
  });

  it('pays only the unprotected limit as the first tranche, leaves the grant open and pays no invite bonus', async () => {
    const adapters = buildAdapters();

    const result = await releaseSignupTranche('user-1', adapters);

    expect(result.creditsGranted).toBe(LIMIT);
    expect(paid).toEqual([{ credits: LIMIT, transactionId: 'verify-grant:user-1' }]);
    expect(user.signupGrant).toMatchObject({ stage: 'signup', nextCondition: 'verification', creditsReleased: LIMIT });
    expect(user.signupGrantAssessment).toMatchObject({ status: 'disabled', credits: LIMIT });
    expect(adapters.db.users.markInviteBonusPaid).not.toHaveBeenCalled();
    expect(paid.some(row => row.transactionId.startsWith('invite-bonus:'))).toBe(false);
  });

  it('pays the remainder on a later unlock without exceeding the full grant', async () => {
    const adapters = buildAdapters();
    await releaseSignupTranche('user-1', adapters);

    const unlock = await unlockSignupGrant('user-1', 'phone_verified', {
      ...adapters,
      validators: { phone_verified: async () => true },
    });
    const again = await unlockSignupGrant('user-1', 'phone_verified', {
      ...adapters,
      validators: { phone_verified: async () => true },
    });

    expect(unlock.creditsGranted).toBe(SIGNUP + UNLOCK - LIMIT);
    expect(again.creditsGranted).toBe(0);
    expect(paid.reduce((sum, row) => sum + row.credits, 0)).toBe(SIGNUP + UNLOCK);
    expect(user.signupGrant).toMatchObject({ stage: 'unlocked', creditsReleased: SIGNUP + UNLOCK });
    expect(paid.some(row => row.transactionId.startsWith('invite-bonus:'))).toBe(false);
  });
});
