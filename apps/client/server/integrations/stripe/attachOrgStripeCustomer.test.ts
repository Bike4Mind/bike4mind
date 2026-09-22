// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError } from '@bike4mind/common';

const mockFindOneAndUpdate = vi.fn();
const mockFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  Organization: { findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

const mockCreateCustomer = vi.fn();
vi.mock('./stripe', () => ({
  createCustomer: (...a: unknown[]) => mockCreateCustomer(...a),
  CustomerType: { User: 'User', Organization: 'Organization' },
}));

import { attachOrgStripeCustomer } from './attachOrgStripeCustomer';

const ORG = '650000000000000000000abc';
const makeOrg = (stripeCustomerId?: string | null) => ({
  id: ORG,
  name: 'Org One',
  billingContact: 'billing@example.com',
  stripeCustomerId,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
  mockFindOneAndUpdate.mockResolvedValue({ id: ORG, stripeCustomerId: 'cus_new' });
});

describe('attachOrgStripeCustomer', () => {
  it('reuses an existing customer id without calling Stripe', async () => {
    const org = makeOrg('cus_existing');

    await expect(attachOrgStripeCustomer(org)).resolves.toBe('cus_existing');

    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('creates and persists a customer on first use', async () => {
    const org = makeOrg(null);

    await expect(attachOrgStripeCustomer(org)).resolves.toBe('cus_new');

    expect(mockCreateCustomer).toHaveBeenCalledWith({
      email: 'billing@example.com',
      name: 'Org One',
      type: 'Organization',
    });
    // Callers keep using the document they passed in, so the mutation has to land on it.
    expect(org.stripeCustomerId).toBe('cus_new');
  });

  // The reason this helper exists rather than an `organizationRepository.update(org)` call: the
  // filter, not the $set. Without `stripeCustomerId: null` in the filter, both racers persist.
  it('guards the write on stripeCustomerId still being null', async () => {
    await attachOrgStripeCustomer(makeOrg(null));

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: ORG, stripeCustomerId: null },
      { $set: { stripeCustomerId: 'cus_new' } },
      { new: true }
    );
  });

  it('adopts the winner id when a concurrent request persisted first', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null); // lost the race
    mockFindById.mockResolvedValue({ id: ORG, stripeCustomerId: 'cus_winner' });
    const org = makeOrg(null);

    // The loser must NOT return the customer it just created, or the checkout session is opened
    // against a Stripe customer the organization document does not point at.
    await expect(attachOrgStripeCustomer(org)).resolves.toBe('cus_winner');
    expect(org.stripeCustomerId).toBe('cus_winner');
  });

  it('fails loudly when the write is lost and no customer id turns up', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockResolvedValue({ id: ORG, stripeCustomerId: null });

    await expect(attachOrgStripeCustomer(makeOrg(null))).rejects.toBeInstanceOf(BadRequestError);
  });
});
