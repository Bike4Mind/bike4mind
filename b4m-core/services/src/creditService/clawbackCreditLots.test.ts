import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clawbackCreditLotsByStripeRef, ClawbackCreditLotsAdapters } from './clawbackCreditLots';

describe('creditService - clawbackCreditLotsByStripeRef', () => {
  let mockFindByStripeRef: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;
  let adapters: ClawbackCreditLotsAdapters;

  beforeEach(() => {
    mockFindByStripeRef = vi.fn();
    mockUpdate = vi.fn().mockResolvedValue({});
    adapters = { db: { creditLots: { findByStripeRef: mockFindByStripeRef, update: mockUpdate } as any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('full mode: reduces lot.amount to consumedAssigned, killing the remaining balance', async () => {
    mockFindByStripeRef.mockResolvedValue([{ id: 'lot1', amount: 500, consumedAssigned: 200 }]);

    await clawbackCreditLotsByStripeRef('pi_123', 'full', 500, adapters);

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'lot1', amount: 200 });
  });

  it('proportional mode: reduces lot.amount by exactly the clawed credits', async () => {
    mockFindByStripeRef.mockResolvedValue([{ id: 'lot1', amount: 1000, consumedAssigned: 100 }]);

    await clawbackCreditLotsByStripeRef('pi_ref', 'proportional', 500, adapters);

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'lot1', amount: 500 });
  });

  it('proportional mode: clamps at consumedAssigned so an already-realized lot cannot shrink below what was assigned', async () => {
    mockFindByStripeRef.mockResolvedValue([{ id: 'lot1', amount: 1000, consumedAssigned: 800 }]);

    // Clawing back 900 would put amount at 100 (below consumedAssigned=800) without the clamp.
    await clawbackCreditLotsByStripeRef('pi_ref', 'proportional', 900, adapters);

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'lot1', amount: 800 });
  });

  it('no matching lot: safe no-op', async () => {
    mockFindByStripeRef.mockResolvedValue([]);

    await clawbackCreditLotsByStripeRef('pi_unknown', 'full', 500, adapters);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('skips the update when the computed amount is unchanged', async () => {
    mockFindByStripeRef.mockResolvedValue([{ id: 'lot1', amount: 200, consumedAssigned: 200 }]);

    await clawbackCreditLotsByStripeRef('pi_123', 'full', 500, adapters);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('applies the clawback to every matching lot', async () => {
    mockFindByStripeRef.mockResolvedValue([
      { id: 'lot1', amount: 300, consumedAssigned: 0 },
      { id: 'lot2', amount: 200, consumedAssigned: 50 },
    ]);

    await clawbackCreditLotsByStripeRef('pi_multi', 'full', 999, adapters);

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'lot1', amount: 0 });
    expect(mockUpdate).toHaveBeenCalledWith({ id: 'lot2', amount: 50 });
  });

  it('is best-effort: swallows a lookup failure instead of throwing', async () => {
    mockFindByStripeRef.mockRejectedValue(new Error('DB unavailable'));

    await expect(clawbackCreditLotsByStripeRef('pi_123', 'full', 500, adapters)).resolves.toBeUndefined();
  });
});
