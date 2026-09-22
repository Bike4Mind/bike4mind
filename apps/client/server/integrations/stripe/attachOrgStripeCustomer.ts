import { Organization, organizationRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { createCustomer, CustomerType } from './stripe';

/** The slice of an organization document this needs; both callers pass a full IOrganizationDocument. */
export type OrgStripeCustomerTarget = {
  id: string;
  name: string;
  billingContact: string;
  stripeCustomerId?: string | null;
};

/**
 * Resolve an organization's Stripe customer id, creating the customer on first use.
 *
 * The conditional `findOneAndUpdate` is the whole point. Two concurrent requests that both find
 * `stripeCustomerId` unset would each create a Stripe customer; with a plain whole-document
 * `organizationRepository.update(org)` both then persist, so the loser's write orphans the
 * winner's paid Stripe record AND clobbers every other field with a document read before the
 * winner's changes. Guarding on `stripeCustomerId: null` makes exactly one writer win, and the
 * loser adopts the winner's id instead.
 *
 * Mutates `organization.stripeCustomerId` so a caller still holding the document (for
 * `users.length`, `name`, ...) sees the same object it passed in.
 *
 * `stripe/portal.ts` runs the identical dance for a USER's customer id against the User model;
 * it is not folded in here because the model, the type and the error wording all differ. If you
 * change the concurrency contract here, change it there too.
 */
export async function attachOrgStripeCustomer(organization: OrgStripeCustomerTarget): Promise<string> {
  if (organization.stripeCustomerId) {
    return organization.stripeCustomerId;
  }

  const customer = await createCustomer({
    email: organization.billingContact,
    name: organization.name,
    type: CustomerType.Organization,
  });

  const won = await Organization.findOneAndUpdate(
    { _id: organization.id, stripeCustomerId: null },
    { $set: { stripeCustomerId: customer.id } },
    { new: true }
  );

  if (won) {
    organization.stripeCustomerId = customer.id;
    return customer.id;
  }

  // Lost the race: another request persisted first. Adopt its id rather than ours, so the
  // checkout session is opened against the customer the organization document actually points at.
  const fresh = await organizationRepository.findById(organization.id);
  if (!fresh?.stripeCustomerId) {
    throw new BadRequestError('Failed to attach Stripe customer to organization');
  }
  organization.stripeCustomerId = fresh.stripeCustomerId;
  return fresh.stripeCustomerId;
}
