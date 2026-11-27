import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentFindById = vi.hoisted(() => vi.fn());
const userFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: agentFindById },
  userRepository: { findById: userFindById },
  creditTransactionRepository: {},
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

const creditServiceMock = vi.hoisted(() => ({ addCredits: vi.fn(), subtractCredits: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ creditService: creditServiceMock }));

import { ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { InsufficientTransferBalanceError, transferCreditsToAgent } from './transferCreditsToAgent';

const AGENT = { id: 'a1', name: 'Scout', userId: 'owner', users: [{ userId: 'u1' }] };

describe('transferCreditsToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFindById.mockResolvedValue(AGENT);
    userFindById.mockResolvedValue({ id: 'owner', currentCredits: 100 });
  });

  it('moves credits for the owner and returns both balances', async () => {
    creditServiceMock.subtractCredits.mockResolvedValue({ currentCredits: 90 });
    creditServiceMock.addCredits.mockResolvedValue({ currentCredits: 10 });

    await expect(transferCreditsToAgent('a1', 'owner', 10)).resolves.toEqual({
      agentName: 'Scout',
      userCredits: 90,
      agentCredits: 10,
    });
    expect(creditServiceMock.subtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner', credits: 10, recipientId: 'a1' }),
      expect.anything()
    );
    expect(creditServiceMock.addCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'a1', credits: 10, senderId: 'owner' }),
      expect.anything()
    );
  });

  it('refuses a stranger with NotFoundError and moves nothing', async () => {
    await expect(transferCreditsToAgent('a1', 'stranger', 10)).rejects.toBeInstanceOf(NotFoundError);
    expect(creditServiceMock.subtractCredits).not.toHaveBeenCalled();
    expect(creditServiceMock.addCredits).not.toHaveBeenCalled();
  });

  it('refuses a shared viewer with ForbiddenError and moves nothing', async () => {
    await expect(transferCreditsToAgent('a1', 'u1', 10)).rejects.toBeInstanceOf(ForbiddenError);
    expect(creditServiceMock.subtractCredits).not.toHaveBeenCalled();
  });

  it('refuses an amount above the balance and moves nothing', async () => {
    await expect(transferCreditsToAgent('a1', 'owner', 101)).rejects.toBeInstanceOf(InsufficientTransferBalanceError);
    expect(creditServiceMock.subtractCredits).not.toHaveBeenCalled();
    expect(creditServiceMock.addCredits).not.toHaveBeenCalled();
  });

  it('allows an amount equal to the balance', async () => {
    creditServiceMock.subtractCredits.mockResolvedValue({ currentCredits: 0 });
    creditServiceMock.addCredits.mockResolvedValue({ currentCredits: 100 });
    await expect(transferCreditsToAgent('a1', 'owner', 100)).resolves.toMatchObject({ userCredits: 0 });
  });
});
