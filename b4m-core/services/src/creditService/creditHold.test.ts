import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, CreditHolderType } from '@bike4mind/common';
import type { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { holdCredits, releaseCreditHold, settleCreditHold, type CreditHoldAdapters } from './creditHold';

vi.mock('./deductCreditsWithOrgSupport', () => ({ deductCreditsWithOrgSupport: vi.fn(async () => undefined) }));
import { deductCreditsWithOrgSupport } from './deductCreditsWithOrgSupport';

const makeAdapters = (balances: { user: number; org?: number }) => {
  const state = { user: balances.user, org: balances.org ?? 0 };
  const user = { id: 'u1', currentCredits: state.user } as unknown as IUserDocument;
  const org = { id: 'o1', currentCredits: state.org } as unknown as IOrganizationDocument;
  const adapters: CreditHoldAdapters = {
    users: {
      findById: vi.fn(async () => ({ ...user, currentCredits: state.user }) as IUserDocument),
      incrementCredits: vi.fn(async (_id: string, delta: number) => {
        state.user += delta;
        return { id: 'u1', currentCredits: state.user } as never;
      }),
    },
    // Only the members holdCredits/settleCreditHold call; the ledger writer is mocked.
    organizations: {
      findById: vi.fn(async () => ({ ...org, currentCredits: state.org }) as IOrganizationDocument),
      incrementCredits: vi.fn(async (_id: string, delta: number) => {
        state.org += delta;
        return { id: 'o1', currentCredits: state.org } as never;
      }),
    } as unknown as CreditHoldAdapters['organizations'],
    creditTransactions: {} as CreditHoldAdapters['creditTransactions'],
  };
  return { adapters, state };
};
const logger = new Logger({ metadata: { test: 'creditHold' } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('holdCredits', () => {
  it('moves the credits out of the user balance and returns plain data', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    expect(hold).toEqual({
      ownerId: 'u1',
      ownerType: CreditHolderType.User,
      userId: 'u1',
      organizationId: null,
      reservedCredits: 30,
      balanceAfterHold: 70,
    });
    expect(state.user).toBe(70);
    expect(JSON.parse(JSON.stringify(hold))).toEqual(hold);
  });

  it('bills the organization pool when an organization is given', async () => {
    const { adapters, state } = makeAdapters({ user: 0, org: 50 });
    const hold = await holdCredits(
      { userId: 'u1', organizationId: 'o1', requiredCredits: 20, featureLabel: 'video', logger },
      adapters
    );
    expect(hold.ownerType).toBe(CreditHolderType.Organization);
    expect(hold.ownerId).toBe('o1');
    expect(state.org).toBe(30);
  });

  it('rolls back and throws insufficient credits when the hold overdraws', async () => {
    const { adapters, state } = makeAdapters({ user: 10 });
    await expect(
      holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger }, adapters)
    ).rejects.toThrow(/do not have enough credits for video/);
    expect(state.user).toBe(10);
  });

  it('logs a failed overdraw rollback and still answers insufficient credits', async () => {
    const { adapters } = makeAdapters({ user: 10 });
    vi.mocked(adapters.users.incrementCredits)
      .mockResolvedValueOnce({ currentCredits: -20 } as never)
      .mockRejectedValueOnce(new Error('db down'));
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await expect(
      holdCredits({ userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger }, adapters)
    ).rejects.toThrow(/do not have enough credits for video/);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('overdraw rollback failed'),
      expect.objectContaining({ ownerId: 'u1', requiredCredits: 30, error: 'db down' })
    );
    error.mockRestore();
  });

  it('reports a holder deleted mid-request as not found, not as insufficient credits', async () => {
    const { adapters } = makeAdapters({ user: 100 });
    vi.mocked(adapters.users.incrementCredits).mockResolvedValueOnce(null);

    const hold = holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    await expect(hold).rejects.toThrow('User not found');
    await expect(hold).rejects.toBeInstanceOf(BadRequestError);
    await expect(hold).rejects.not.toThrow(/enough credits/);
  });

  it('reports a billing org deleted mid-request as not found, not as insufficient credits', async () => {
    const { adapters } = makeAdapters({ user: 100, org: 100 });
    vi.mocked(adapters.organizations.incrementCredits).mockResolvedValueOnce(null);

    const hold = holdCredits(
      { userId: 'u1', organizationId: 'o1', requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    await expect(hold).rejects.toThrow('Billing organization not found');
    await expect(hold).rejects.toBeInstanceOf(BadRequestError);
  });

  it.each([-5, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a non-positive or non-finite amount (%s) before reading anything',
    async requiredCredits => {
      const { adapters, state } = makeAdapters({ user: 100 });
      await expect(
        holdCredits({ userId: 'u1', organizationId: null, requiredCredits, featureLabel: 'video', logger }, adapters)
      ).rejects.toThrow(`video credit hold requires a positive finite amount, got ${requiredCredits}`);
      expect(adapters.users.findById).not.toHaveBeenCalled();
      expect(adapters.users.incrementCredits).not.toHaveBeenCalled();
      expect(state.user).toBe(100);
    }
  );

  it('runs assertBillable before moving any balance', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    await expect(
      holdCredits(
        {
          userId: 'u1',
          organizationId: null,
          requiredCredits: 30,
          featureLabel: 'video',
          logger,
          assertBillable: () => {
            throw new Error('nope');
          },
        },
        adapters
      )
    ).rejects.toThrow('nope');
    expect(state.user).toBe(100);
  });
});

describe('settleCreditHold', () => {
  const entry = { type: 'video_generation_usage', sessionId: 's1', model: 'test-video' } as never;

  it('refunds the over-reservation and writes the ledger row for what was kept', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    const charged = await settleCreditHold(hold, 20, entry, { featureLabel: 'video', logger }, adapters);
    expect(charged).toBe(20);
    expect(state.user).toBe(80);
    expect(deductCreditsWithOrgSupport).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 20 }),
      expect.anything(),
      expect.objectContaining({ skipBalanceUpdate: true })
    );
  });

  it('never keeps more than it reserved', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    expect(await settleCreditHold(hold, 999, entry, { featureLabel: 'video', logger }, adapters)).toBe(30);
    expect(state.user).toBe(70);
  });

  it.each(['text_to_speech_usage', 'speech_to_text_usage'] as const)(
    'settles %s through the shared refund policy and its native ledger writer',
    async type => {
      const { adapters, state } = makeAdapters({ user: 100 });
      const createTransaction = vi.fn().mockResolvedValue(undefined);
      adapters.creditTransactions = { createTransaction } as unknown as CreditHoldAdapters['creditTransactions'];
      const hold = await holdCredits(
        { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'speech', logger },
        adapters
      );

      const charged = await settleCreditHold(
        hold,
        20,
        { type, model: 'speech-model', sessionId: 's1' },
        { featureLabel: 'speech', logger },
        adapters
      );

      expect(charged).toBe(20);
      expect(state.user).toBe(80);
      expect(createTransaction).toHaveBeenCalledWith(
        type,
        expect.objectContaining({ ownerId: 'u1', credits: -20, model: 'speech-model', sessionId: 's1' })
      );
      expect(deductCreditsWithOrgSupport).not.toHaveBeenCalled();
      expect(adapters.users.incrementCredits).toHaveBeenCalledTimes(2);
    }
  );

  it('settles a hold that went through JSON, as a different process would', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    const revived = JSON.parse(JSON.stringify(hold));
    expect(await settleCreditHold(revived, 10, entry, { featureLabel: 'video', logger }, adapters)).toBe(10);
    expect(state.user).toBe(90);
  });

  it('keeps the full reservation and logs when the charge is not finite', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    expect(await settleCreditHold(hold, Number.NaN, entry, { featureLabel: 'video', logger }, adapters)).toBe(30);
    expect(state.user).toBe(70);
    expect(errorSpy).toHaveBeenCalledWith('video settled with a non-finite charge - keeping the full reservation', {
      ownerId: 'u1',
      chargedCredits: 'NaN',
    });
    expect(deductCreditsWithOrgSupport).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 30 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('logs rather than throws when the ledger write fails', async () => {
    const { adapters } = makeAdapters({ user: 100 });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(deductCreditsWithOrgSupport).mockRejectedValueOnce(new Error('ledger down'));
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    expect(await settleCreditHold(hold, 30, entry, { featureLabel: 'video', logger }, adapters)).toBe(30);
    expect(errorSpy).toHaveBeenCalledWith(
      'video usage transaction write failed - credits charged, ledger row missing',
      { userId: 'u1', organizationId: undefined, error: 'ledger down' }
    );
  });
});

describe('releaseCreditHold', () => {
  it('returns the whole reservation', async () => {
    const { adapters, state } = makeAdapters({ user: 100 });
    const hold = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 30, featureLabel: 'video', logger },
      adapters
    );
    await releaseCreditHold(hold, adapters);
    expect(state.user).toBe(100);
  });
});
