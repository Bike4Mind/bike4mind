import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockList = vi.fn();
const mockVoidInvoice = vi.fn();

vi.mock('@server/integrations/stripe/stripe', () => ({
  stripe: {
    invoices: {
      list: (...args: unknown[]) => mockList(...args),
      voidInvoice: (...args: unknown[]) => mockVoidInvoice(...args),
    },
  },
}));

import { voidOpenSubscriptionInvoices } from './dunning';

const openInvoice = (id: string) => ({ id });

describe('voidOpenSubscriptionInvoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoidInvoice.mockResolvedValue({});
  });

  it('voids every open invoice on the subscription and reports the ids', async () => {
    mockList.mockResolvedValue({ data: [openInvoice('in_a'), openInvoice('in_b')] });

    const result = await voidOpenSubscriptionInvoices('sub_1');

    expect(mockVoidInvoice).toHaveBeenCalledTimes(2);
    expect(mockVoidInvoice).toHaveBeenCalledWith('in_a');
    expect(mockVoidInvoice).toHaveBeenCalledWith('in_b');
    expect(result).toEqual({ voided: ['in_a', 'in_b'], failed: [] });
  });

  it('queries only open invoices of that subscription', async () => {
    mockList.mockResolvedValue({ data: [] });

    await voidOpenSubscriptionInvoices('sub_1');

    expect(mockList).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'open', limit: 100 });
  });

  it('bounds the sweep to invoices created before the cutoff when one is given', async () => {
    // A period-end cancel keeps the subscriber spending, and their new proration
    // invoice is a real charge - only the invoices that already existed go.
    mockList.mockResolvedValue({ data: [openInvoice('in_a')] });

    await voidOpenSubscriptionInvoices('sub_1', { createdBefore: 1700000000 });

    expect(mockList).toHaveBeenCalledWith({
      subscription: 'sub_1',
      status: 'open',
      limit: 100,
      created: { lt: 1700000000 },
    });
  });

  it('does not send a created filter when the cutoff is absent or null', async () => {
    mockList.mockResolvedValue({ data: [] });

    await voidOpenSubscriptionInvoices('sub_1');
    await voidOpenSubscriptionInvoices('sub_1', { createdBefore: null });

    for (const call of mockList.mock.calls) {
      expect(call[0]).not.toHaveProperty('created');
    }
  });

  it('is a silent no-op when nothing is open', async () => {
    mockList.mockResolvedValue({ data: [] });

    const result = await voidOpenSubscriptionInvoices('sub_1');

    expect(mockVoidInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({ voided: [], failed: [] });
  });

  it('does not abandon the remaining invoices when one void fails', async () => {
    mockList.mockResolvedValue({ data: [openInvoice('in_a'), openInvoice('in_b'), openInvoice('in_c')] });
    mockVoidInvoice.mockImplementation(async (id: string) => {
      if (id === 'in_b') throw new Error('invoice is no longer open');
      return {};
    });

    const result = await voidOpenSubscriptionInvoices('sub_1');

    expect(result).toEqual({ voided: ['in_a', 'in_c'], failed: ['in_b'] });
    expect(mockVoidInvoice).toHaveBeenCalledTimes(3);
  });
});
